"""The weekly pipeline behind /internal/*. Phase A (warehouse) runs once per tenant; phase B
(detect -> prompt -> llm -> ingest) runs per role node and never touches the warehouse."""

import uuid
from collections import defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select, update

from app.core.db import tenant_tx
from app.core.logging import get_logger
from app.core.settings import get_settings
from app.domain import agents as agent_rules
from app.domain import card_trust
from app.domain import org as org_rules
from app.domain import runs as run_rules
from app.domain.card_validation import (
    CardCandidate,
    ValidationContext,
    fit_title,
    group_numbers,
    validate,
)
from app.domain.cards import Ranked, plan_storage, score
from app.domain.detection import MetricInfo, Point, detect
from app.domain.filtering import select_signals
from app.domain.llm import validate_choice
from app.domain.outcomes import clamp_window
from app.domain.prompting import ActiveRule, Prompt, PromptSignal, RoleProfile, build_prompt
from app.domain.templates import TemplateError, check_contract, render
from app.integrations.llm import get_llm, parse_raw, prompt_payload
from app.integrations.snowflake import SnowflakeWarehouse
from app.integrations.warehouse import WarehouseClient
from app.models import (
    Agent,
    CardRejection,
    InsightCard,
    LlmCallLog,
    MetricSnapshot,
    Outcome,
    RoleArchetype,
    RoleMetric,
    RoleNode,
    RoleSummary,
    Run,
    Signal,
    Tenant,
)
from app.repositories import agents as agent_repo
from app.repositories import cards as card_repo
from app.repositories import org as org_repo
from app.repositories import pipeline as repo
from app.repositories import runs as run_repo
from app.services import mapping_health
from app.services.llm_settings import Choice, effective_choice
from app.services.runs import step

log = get_logger(__name__)


def _dec(value: float | None, places: int) -> Decimal | None:
    return None if value is None else Decimal(str(round(value, places)))


async def _query_template(
    warehouse: WarehouseClient,
    conn: Any,
    tpl: Any,
    maps: dict[str, Any],
    params: dict[str, Any],
    tag: str,
    rules: Any,
) -> tuple[str, Any, dict[str, Any], float]:
    """Render and run a template's main query and its drivers. Returns sql, result, drivers, s."""
    main_sql = render(tpl.sql, tpl.aliases, maps)
    check_contract(main_sql)
    timeout, cap = rules.query_timeout_seconds, rules.query_row_cap
    result = await warehouse.query(conn, main_sql, params, tag, timeout, cap)
    seconds, drivers = result.seconds, {}
    for name, spec in tpl.drivers.items():
        top_items = spec.get("kind") == "top_items"
        if top_items and rules.top_items_per_problem <= 0:
            continue  # the workspace sends totals only
        driver_sql = render(spec["sql"], tpl.aliases, maps)
        check_contract(driver_sql)
        driver_params = {**params, "top_n": rules.top_items_per_problem} if top_items else params
        d = await warehouse.query(conn, driver_sql, driver_params, f"{tag}:{name}", timeout, cap)
        seconds += d.seconds
        by_entity: dict[str, Any] = {}
        for r in d.rows:
            row = {k: v for k, v in r.items() if k != "entity"}
            if top_items:  # several rows per entity: the items behind it, biggest first
                by_entity.setdefault(str(r["entity"]), []).append(row)
            else:
                by_entity[str(r["entity"])] = row
        drivers[name] = {"exposure": spec.get("exposure"), "kind": spec.get("kind"),
                         "by_entity": by_entity}  # fmt: skip
    return main_sql, result, drivers, seconds


# ---------------------------------------------------------------------------------------------
# Phase A: warehouse
# ---------------------------------------------------------------------------------------------


async def _mapping_health(
    warehouse: WarehouseClient, conn: Any, tenant_id: uuid.UUID, maps: dict[str, Any], rules: Any
) -> dict[str, Any]:
    """The health look must never stop a run: any error here is recorded as `unknown`."""
    try:
        return await mapping_health.check(warehouse, conn, tenant_id, maps, rules)
    except Exception as exc:
        log.warning("mapping.health_failed", error=str(exc)[:300])
        return {"status": "unknown", "archetypes": [], "error": str(exc)[:300]}


async def run_metrics(
    tenant_id: uuid.UUID, run_id: uuid.UUID, warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    warehouse = warehouse or SnowflakeWarehouse()
    async with step(tenant_id, run_id, None, "metrics_run") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            run = await s.get(Run, run_id)
            assert run is not None
            conn = await repo.connection(s)
            maps = await repo.mappings(s)
            rules = await org_repo.rules(s)
            metrics = await repo.metrics_for_run(s, daily_only=run.type == "daily_check")
            templates = {
                m.id: await repo.template(s, m.sql_template_key, m.sql_template_version)
                for m in metrics
            }
        if conn is None:
            outcome.update(status="skipped", reason="no warehouse connection")
            return outcome
        if not metrics:
            outcome.update(status="skipped", reason="no metrics attached to roles")
            return outcome

        if run.type != "daily_check":  # the daily check stays light: health is a weekly look
            health = await _mapping_health(warehouse, conn, tenant_id, maps, rules)
            outcome.update(mapping_health=health)
            if health["status"] != "ok":
                log.warning("mapping.health", status=health["status"], archetypes=[
                    {"archetype": a["archetype"], "status": a["status"], "issues": a["issues"]}
                    for a in health.get("archetypes", []) if a["status"] != "ok"
                ])  # fmt: skip

        done, failed, truncated, seconds = 0, [], [], 0.0
        for metric in metrics:  # back to back, so the warehouse resumes once
            tpl = templates[metric.id]
            tag = f"formada:{tenant_id}:{run_id}:{metric.key}"
            try:
                if tpl is None:
                    raise TemplateError(
                        f"template {metric.sql_template_key} v{metric.sql_template_version} missing"
                    )
                params = {
                    **{k: v.get("default") for k, v in tpl.params_schema.items()},
                    **metric.params,
                    "period_end": run.period_end,
                    "row_cap": rules.query_row_cap,
                }
                main_sql, result, drivers, q_seconds = await _query_template(
                    warehouse, conn, tpl, maps, params, tag, rules
                )
            except Exception as exc:  # one metric failing must not stop the others
                failed.append({"metric": metric.key, "error": str(exc)[:500]})
                log.warning("metric.failed", metric=metric.key, error=str(exc)[:300])
                continue

            if result.truncated:  # rows beyond the cap were dropped: series may be incomplete
                truncated.append(metric.key)
                log.warning("metric.truncated", metric=metric.key, row_cap=rules.query_row_cap)
            series: dict[str, list[dict[str, Any]]] = defaultdict(list)
            for r in result.rows:
                series[str(r["entity"])].append(
                    {"week": r["period_start"], "value": r["value"], "n": r.get("n")}
                )
            latest = [pts[-1]["value"] for pts in series.values() if pts]
            async with tenant_tx("service", tenant_id) as s:
                s.add(
                    MetricSnapshot(
                        tenant_id=tenant_id,
                        run_id=run_id,
                        metric_id=metric.id,
                        period_end=run.period_end,
                        value=_dec(sum(latest) / len(latest), 4) if latest else None,
                        series=series,
                        breakdown=drivers,
                        sql_text=main_sql,
                        row_count=len(result.rows),
                        query_seconds=_dec(q_seconds, 3),
                    )
                )
                await s.execute(
                    update(Run)
                    .where(Run.id == run_id)
                    .values(query_seconds=Run.query_seconds + q_seconds)
                )
            done += 1
            seconds += q_seconds

        if not done:
            raise RuntimeError(f"all {len(failed)} metrics failed: {failed}")
        outcome.update(
            snapshots=done, failed=failed, truncated=truncated, query_seconds=round(seconds, 3)
        )
    return outcome


async def daily_plan(tenant_id: uuid.UUID, run_id: uuid.UUID) -> dict[str, Any]:
    """WF2, after the daily metrics: which roles run the role pipeline today (ADR 0019).
    Each planned role gets a daily_plan step, so finish can tell a role that never ran."""
    async with step(tenant_id, run_id, None, "daily_plan") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            roles = (
                await s.scalars(
                    select(RoleNode).where(RoleNode.id.in_(select(RoleMetric.role_node_id)))
                )
            ).all()
            candidates = []
            for role in roles:
                checks = []
                for rm, metric in await repo.role_metrics(s, role.id):
                    if not rm.daily_check:
                        continue
                    snap = await repo.snapshot(s, run_id, metric.id)
                    if snap is None:
                        continue
                    checks.append(
                        run_rules.DailyCheck(
                            metric_key=metric.key,
                            threshold=float(rm.threshold) if rm.threshold is not None else None,
                            higher_is_better=metric.higher_is_better,
                            latest={
                                e: float(pts[-1]["value"]) for e, pts in snap.series.items() if pts
                            },
                        )
                    )
                candidates.append(run_rules.DailyRole(role.id, role.title, role.cadence, checks))
            plan = run_rules.daily_plan(candidates)
            for planned, reason in plan:
                await run_repo.start_step(s, tenant_id, run_id, planned.role_node_id, "daily_plan")
                await run_repo.finish_step(
                    s, run_id, planned.role_node_id, "daily_plan", "ok", {"reason": reason}
                )
        outcome.update(
            status="ok" if plan else "skipped",
            role_nodes=[
                {"id": str(r.role_node_id), "title": r.title, "reason": why} for r, why in plan
            ],
        )
        if not plan:
            outcome["reason"] = "no breach and no daily-cadence role"
    return outcome


# ---------------------------------------------------------------------------------------------
# Phase B: per role node
# ---------------------------------------------------------------------------------------------


def snapshot_inputs(
    snap: Any,
) -> tuple[dict[str, list[Point]], dict[str, dict[str, Any]], dict[str, float]]:
    """What detection reads from a metric snapshot: the weekly series per entity, the driver
    breakdowns per entity, and how much each entity has at stake (its exposure)."""
    series = {
        entity: [
            Point(date.fromisoformat(p["week"][:10]), float(p["value"]), p.get("n")) for p in pts
        ]
        for entity, pts in snap.series.items()
    }
    drivers_by_entity: dict[str, dict[str, Any]] = defaultdict(dict)
    exposure: dict[str, float] = {}
    for name, d in snap.breakdown.items():
        for entity, values in d["by_entity"].items():
            drivers_by_entity[entity][name] = values
            if isinstance(values, dict) and d.get("exposure") and d["exposure"] in values:
                exposure[entity] = float(values[d["exposure"]] or 0)
    return series, drivers_by_entity, exposure


async def detect_role(
    s: Any,
    tenant: Tenant,
    run_id: uuid.UUID,
    role_id: uuid.UUID,
    rules: Any,
    patch: dict[uuid.UUID, dict[str, Any]] | None = None,
) -> tuple[list[Any], dict[int, tuple[uuid.UUID, uuid.UUID, str]]]:
    """Detection and filtering for one role on a run's snapshots, with no writes. The console's
    preview passes `patch` (role_metric id -> weight/threshold) to try numbers before saving."""
    patch = patch or {}
    pairs = await repo.role_metrics(s, role_id)
    state = await repo.feedback_state(s, role_id, rules.not_relevant_suppress_days)
    drafts, snapshot_of = [], {}
    weights: dict[str, float] = {}
    for rm, metric in pairs:
        change = patch.get(rm.id, {})
        threshold = change.get("threshold", rm.threshold)
        weights[metric.key] = float(change.get("weight", rm.weight))
        snap = await repo.snapshot(s, run_id, metric.id)
        if snap is None:
            continue
        info = MetricInfo(
            key=metric.key,
            name=metric.name,
            unit=metric.unit,
            higher_is_better=metric.higher_is_better,
            unit_value=float(metric.unit_value),
            currency=tenant.currency,
            threshold=float(threshold) if threshold is not None else None,
        )
        series, drivers_by_entity, exposure = snapshot_inputs(snap)
        for draft in detect(info, series, drivers_by_entity, exposure, rules):
            drafts.append(draft)
            snapshot_of[id(draft)] = (metric.id, snap.id, snap.sql_text)
    return select_signals(drafts, weights, state, rules), snapshot_of


async def detect_signals(
    tenant_id: uuid.UUID, run_id: uuid.UUID, role_id: uuid.UUID
) -> dict[str, Any]:
    async with step(tenant_id, run_id, role_id, "signals_detect") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            tenant = await s.get(Tenant, tenant_id)
            assert tenant is not None
            rules = await org_repo.rules(s)
            pairs = await repo.role_metrics(s, role_id)
            if not pairs:
                outcome.update(status="skipped", reason="role has no metrics")
                return outcome
            await s.execute(
                delete(Signal).where(Signal.run_id == run_id, Signal.role_node_id == role_id)
            )
            decisions, snapshot_of = await detect_role(s, tenant, run_id, role_id, rules)
            drafts = [d.signal for d in decisions]
            for d in decisions:
                metric_id, snapshot_id, sql_text = snapshot_of[id(d.signal)]
                sig = d.signal
                s.add(
                    Signal(
                        tenant_id=tenant_id,
                        run_id=run_id,
                        role_node_id=role_id,
                        metric_id=metric_id,
                        snapshot_id=snapshot_id,
                        kind=sig.kind,
                        entity=sig.entity,
                        direction=sig.direction,
                        fingerprint=sig.fingerprint,
                        value=_dec(sig.value, 4),
                        baseline=_dec(sig.baseline, 4),
                        zscore=_dec(sig.zscore, 3),
                        change_pct=_dec(sig.change_pct, 3),
                        est_impact=_dec(sig.est_impact, 2),
                        impact_unit=sig.impact_unit,
                        score=_dec(d.score, 4),
                        evidence={
                            **sig.evidence,
                            **_trust(sig.evidence, rules),
                            "source": {"snapshot_id": str(snapshot_id), "sql": sql_text},
                        },
                        status=d.status,
                        status_reason=d.reason,
                    )
                )
        selected = sum(1 for d in decisions if d.status == "selected")
        outcome.update(
            status="ok" if selected else "skipped",
            detected=len(drafts),
            selected=selected,
            suppressed=sum(1 for d in decisions if d.status == "suppressed"),
        )
    return outcome


async def _profile(s: Any, role_id: uuid.UUID) -> tuple[RoleProfile, str | None]:
    found = await repo.role_with_department(s, role_id)
    assert found is not None
    role, dept = found
    profile = RoleProfile(
        title=role.title,
        department=dept.name if dept else None,
        language=get_settings().card_language or role.language,
        decisions_owned=list(role.decisions_owned),
        decisions_forbidden=list(role.decisions_forbidden),
        kpi_notes=role.kpi_notes,
    )
    if dept is not None:
        return profile, dept.playbook
    # A role outside the department boxes (the CEO) uses its archetype's playbook.
    playbook = await s.scalar(
        select(RoleArchetype.playbook).where(RoleArchetype.key == role.role_archetype_key)
    )
    return profile, playbook


def _trust(evidence: dict[str, Any], rules: Any) -> dict[str, Any]:
    """The notes (English, for the card writer) and their codes (for the app to translate) when
    the number should be confirmed at the source, else nothing."""
    codes = card_trust.note_codes(evidence, rules)
    if not codes:
        return {}
    return {
        "data_notes": [card_trust.format_note(n["code"], n["values"]) for n in codes],
        "data_note_codes": codes,
    }


def _prompt_signal(sig: Signal, metric_key: str) -> PromptSignal:
    evidence = {k: v for k, v in sig.evidence.items() if k != "source"}  # SQL is not for the LLM
    return PromptSignal(str(sig.id), metric_key, sig.kind, sig.entity, sig.direction, evidence)


async def build_role_prompt(
    tenant_id: uuid.UUID, run_id: uuid.UUID, role_id: uuid.UUID
) -> dict[str, Any]:
    async with step(tenant_id, run_id, role_id, "prompt_build") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            signals = await repo.selected_signals(s, run_id, role_id)
            if not signals:
                outcome.update(status="skipped", reason="no selected signals")
                return outcome
            profile, playbook = await _profile(s, role_id)
            # The role's card-writer agent supplies the instructions (ADR 0022); without one,
            # the catalog's shared system prompt.
            agent = await agent_repo.active(s, f"card_writer_{playbook}") if playbook else None
            system = agent[1].body if agent else await repo.prompt_body(s, "system")
            prompt = build_prompt(
                system=system,
                playbook=await repo.prompt_body(s, f"playbook_{playbook}") if playbook else "",
                profile=profile,
                rules=[
                    ActiveRule(r.rule_type, r.text) for r in await repo.active_rules(s, role_id)
                ],
                signals=[_prompt_signal(sig, key) for sig, key in signals],
            )
            examples = 0
            rules = await org_repo.rules(s)
            if agent and agent[0].use_examples and rules.agent_examples_max:
                owned = org_rules.owned_nodes(await org_repo.nodes(s), role_id) | {role_id}
                since = datetime.now(UTC) - timedelta(days=rules.agent_examples_days)
                positive, negative = agent_rules.select_examples(
                    await agent_repo.past_cards(s, list(owned), since),
                    {key for _sig, key in signals},
                    since,
                    rules.agent_examples_max,
                )
                examples = len(positive) + len(negative)
                prompt = Prompt(
                    prompt.system, prompt.user + agent_rules.examples_block(positive, negative)
                )
            s.add(
                LlmCallLog(
                    tenant_id=tenant_id,
                    run_id=run_id,
                    role_node_id=role_id,
                    provider="pending",
                    model="pending",
                    prompt=prompt_payload(prompt),
                    status="built",
                    agent_key=agent[0].key if agent else None,
                    agent_version=agent[1].version if agent else None,
                )
            )
        outcome.update(
            signals=len(signals),
            prompt_chars=len(prompt.system) + len(prompt.user),
            agent=f"{agent[0].key} v{agent[1].version}" if agent else None,
            examples=examples,
        )
    return outcome


async def generate_cards(
    tenant_id: uuid.UUID, run_id: uuid.UUID, role_id: uuid.UUID
) -> dict[str, Any]:
    async with step(tenant_id, run_id, role_id, "llm_generate") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            call = await repo.latest_call(s, run_id, role_id)
            if call is None:
                outcome.update(status="skipped", reason="no prompt built")
                return outcome
            signals = await repo.selected_signals(s, run_id, role_id)
            profile, _ = await _profile(s, role_id)
            call_id, payload = call.id, call.prompt
            choice = await effective_choice(s)
            agent = await s.get(Agent, call.agent_key) if call.agent_key else None
            if agent and agent.model_override:  # set by the internal team for this agent only
                provider, _, model = agent.model_override.partition("/")
                if not validate_choice(provider, model):
                    choice = Choice(provider, model, "agent")
        result = await get_llm(choice.provider, choice.model).generate(
            Prompt(payload["system"], payload["user"]),
            [_prompt_signal(sig, key) for sig, key in signals],
            profile,
        )
        async with tenant_tx("service", tenant_id) as s:
            call = await s.get(LlmCallLog, call_id)
            assert call is not None
            call.provider, call.model, call.response = result.provider, result.model, result.raw
            call.input_tokens, call.output_tokens = result.input_tokens, result.output_tokens
            call.latency_ms, call.error = result.latency_ms, result.error
            call.status = "ok" if result.batch is not None else "failed"
            await s.execute(
                update(Run)
                .where(Run.id == run_id)
                .values(llm_tokens=Run.llm_tokens + result.input_tokens + result.output_tokens)
            )
        if result.batch is None:
            outcome.update(status="failed", error=result.error)
            return outcome
        outcome.update(
            cards_proposed=len(result.batch.cards),
            tokens=result.input_tokens + result.output_tokens,
            model=result.model,
        )
    return outcome


async def validation_context(
    s: Any,
    role_id: uuid.UUID,
    profile: RoleProfile,
    signals: dict[str, Signal],
    open_fingerprints: frozenset[str],
) -> ValidationContext:
    """What a card is checked against. Shared by ingest and the agent evaluator (ADR 0022)."""
    forbid_texts = [r.text for r in await repo.active_rules(s, role_id) if r.rule_type == "forbid"]
    return ValidationContext(
        language=profile.language,
        evidence_by_signal={k: v.evidence for k, v in signals.items()},
        fingerprint_by_signal={k: v.fingerprint for k, v in signals.items()},
        decisions_owned=profile.decisions_owned,
        decisions_forbidden=profile.decisions_forbidden,
        forbid_rules=forbid_texts,
        open_fingerprints=open_fingerprints,
        profile_text=" ".join(
            [*profile.decisions_owned, *profile.decisions_forbidden, profile.kpi_notes or ""]
        ),
    )


def check_drafts(drafts: list[Any], ctx: ValidationContext) -> list[tuple[Any, list[str]]]:
    """Each draft with its rejection reasons (empty = valid), duplicates included."""
    out, seen = [], set()
    for draft in drafts:
        reasons = validate(
            CardCandidate(
                draft.signal_id, draft.title, draft.what, draft.so_what, draft.now_what,
                draft.decision_used,
            ),
            ctx,
        )  # fmt: skip
        if draft.signal_id in seen:
            reasons.append("duplicate card for the same signal")
        if not reasons:
            seen.add(draft.signal_id)
        out.append((draft, reasons))
    return out


async def ingest_cards(
    tenant_id: uuid.UUID, run_id: uuid.UUID, role_id: uuid.UUID
) -> dict[str, Any]:
    async with step(tenant_id, run_id, role_id, "cards_ingest") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            call = await repo.latest_call(s, run_id, role_id)
            if call is None or call.status != "ok" or not call.response:
                outcome.update(status="skipped", reason="no LLM output")
                return outcome
            batch = parse_raw(call.response)
            generated_by = f"{call.provider}/{call.model}"
            agent_key, agent_version = call.agent_key, call.agent_version
            rules = await org_repo.rules(s)
            nodes = await org_repo.nodes(s)
            profile, _ = await _profile(s, role_id)
            signals = {
                str(sig.id): sig for sig, _key in await repo.selected_signals(s, run_id, role_id)
            }
            owner = org_rules.nearest_filled_ancestor(nodes, role_id) or role_id
            owned = org_rules.owned_nodes(nodes, owner)
            existing = await card_repo.open_cards(s, owned)
            ctx = await validation_context(
                s, role_id, profile, signals,
                frozenset(c.fingerprint for c in existing if c.role_node_id == role_id),
            )  # fmt: skip
            valid, rejected, seen = [], 0, set()
            for draft in batch.cards:
                reasons = validate(
                    CardCandidate(
                        draft.signal_id,
                        draft.title,
                        draft.what,
                        draft.so_what,
                        draft.now_what,
                        draft.decision_used,
                    ),
                    ctx,
                )
                if draft.signal_id in seen:
                    reasons.append("duplicate card for the same signal")
                if reasons:
                    rejected += 1
                    s.add(
                        CardRejection(
                            tenant_id=tenant_id,
                            run_id=run_id,
                            role_node_id=role_id,
                            payload=draft.model_dump(),
                            reasons=reasons,
                        )
                    )
                    continue
                seen.add(draft.signal_id)
                valid.append(draft)

            # Numbers are found by code: impact comes from the signal, never from the LLM.
            for d in valid:
                sig_impact = float(signals[d.signal_id].est_impact)
                if abs(d.expected_impact - sig_impact) > 0.5:
                    log.info("card.impact_overridden", llm=d.expected_impact, signal=sig_impact)
            plan = plan_storage(
                [
                    Ranked(str(c.id), score(c.expected_impact, c.confidence), False)
                    for c in existing
                ],
                [
                    Ranked(d.signal_id, score(signals[d.signal_id].est_impact, d.confidence), True)
                    for d in valid
                ],
                rules.max_open_cards_per_role,
            )
            now = datetime.now(UTC)
            by_signal = {d.signal_id: d for d in valid}
            priority = {key: rank for rank, key in enumerate(plan.keep, start=1)}
            for c in existing:
                if str(c.id) in priority:
                    c.priority = priority[str(c.id)]
            for sig_id in plan.accept:
                d, sig = by_signal[sig_id], signals[sig_id]
                s.add(
                    InsightCard(
                        tenant_id=tenant_id,
                        role_node_id=role_id,
                        run_id=run_id,
                        signal_id=sig.id,
                        status="open",
                        title=fit_title(group_numbers(d.title, profile.language)),
                        what=group_numbers(d.what, profile.language),
                        so_what=group_numbers(d.so_what, profile.language),
                        now_what=group_numbers(d.now_what, profile.language),
                        decision_used=d.decision_used,
                        evidence=sig.evidence,
                        expected_impact=sig.est_impact,
                        impact_unit=sig.impact_unit,
                        confidence=_dec(min(max(d.confidence, 0.0), 1.0), 3),
                        priority=priority[sig_id],
                        fingerprint=sig.fingerprint,
                        language=profile.language,
                        suggested_window_days=clamp_window(d.suggested_window_days, rules),
                        suggested_metric_key=d.suggested_metric_key,
                        generated_by=generated_by,
                        agent_key=agent_key,
                        agent_version=agent_version,
                        expires_at=now + timedelta(days=rules.card_expiry_days),
                    )
                )
                sig.status = "carded"
            if plan.expire:
                await s.execute(
                    update(InsightCard)
                    .where(InsightCard.id.in_([uuid.UUID(i) for i in plan.expire]))
                    .values(status="expired", closed_at=now)
                )
        outcome.update(
            accepted=len(plan.accept),
            rejected=rejected,
            over_cap=len(plan.over_cap),
            expired=len(plan.expire),
        )
    return outcome


# ---------------------------------------------------------------------------------------------
# Tenant-level after phase B
# ---------------------------------------------------------------------------------------------


async def rollup(tenant_id: uuid.UUID, run_id: uuid.UUID) -> dict[str, Any]:
    """Refresh role_summary (ADR 0007): open cards and value captured, own and subtree."""
    async with step(tenant_id, run_id, None, "rollup") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            nodes = await org_repo.nodes(s)
            open_by_role = dict(
                (
                    await s.execute(
                        select(InsightCard.role_node_id, func.count())
                        .where(InsightCard.status == "open")
                        .group_by(InsightCard.role_node_id)
                    )
                )
                .tuples()
                .all()
            )
            value_by_role = dict(
                (
                    await s.execute(
                        select(Outcome.role_node_id, func.sum(Outcome.value_captured))
                        .where(Outcome.kind == "end")
                        .group_by(Outcome.role_node_id)
                    )
                )
                .tuples()
                .all()
            )
            now = datetime.now(UTC)
            await s.execute(delete(RoleSummary))
            for node_id in nodes:
                owned = (
                    org_rules.owned_nodes(nodes, node_id) if not nodes[node_id].vacant else set()
                )
                subtree = org_rules.descendants(nodes, node_id) | {node_id}
                s.add(
                    RoleSummary(
                        tenant_id=tenant_id,
                        role_node_id=node_id,
                        open_cards=sum(open_by_role.get(n, 0) for n in owned),
                        open_cards_subtree=sum(open_by_role.get(n, 0) for n in subtree),
                        value_captured=sum((value_by_role.get(n) or Decimal(0)) for n in owned),
                        value_captured_subtree=sum(
                            (value_by_role.get(n) or Decimal(0)) for n in subtree
                        ),
                        refreshed_at=now,
                    )
                )
        outcome.update(nodes=len(nodes), open_cards=sum(open_by_role.values()))
    return outcome
