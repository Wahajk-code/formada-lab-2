"""Internal console (ADR 0020): our team's cross-workspace view and controls.

Staff are not people of any workspace, so the console never uses a user session. It reads and
writes one workspace at a time through the service connection, which RLS still scopes to that
workspace (no role bypasses RLS). Every write is recorded in config_change and, for workspace
data, in the workspace's own audit log.
"""

import uuid
from collections import Counter
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import delete, func, select

from app.core.db import global_tx, tenant_tx
from app.core.errors import Invalid, NotFound
from app.domain import card_quality, scorecard
from app.domain import config as cfg
from app.domain import feedback as fb_rules
from app.domain import llm as llm_catalog
from app.models import (
    AuditLog,
    CardRejection,
    ConfigChange,
    Feedback,
    FeedbackRule,
    InsightCard,
    Invite,
    LlmCallLog,
    Metric,
    OnboardingThread,
    Outcome,
    Person,
    RoleMetric,
    RoleNode,
    Run,
    RunStep,
    Signal,
    SystemConfig,
    Tenant,
    WarehouseConnection,
)
from app.models import RulesConfig as RulesConfigRow
from app.repositories import org as org_repo
from app.services import org as org_service
from app.services.llm_settings import effective_choice
from app.services.ops import XS_CREDITS_PER_SECOND

QUALITY_DAYS = 90


def _f(v: Decimal | float | None) -> float:
    return float(v or 0)


async def _tenants() -> list[Tenant]:
    async with global_tx("service") as s:
        return list((await s.scalars(select(Tenant).order_by(Tenant.name))).all())


async def _tenant(tenant_id: uuid.UUID) -> Tenant:
    for t in await _tenants():
        if t.id == tenant_id:
            return t
    raise NotFound("workspace")


async def _log(
    actor: str, scope: str, key: str, old: Any, new: Any, workspace: uuid.UUID | None = None
) -> None:
    async with global_tx("service") as s:
        s.add(
            ConfigChange(
                workspace_id=workspace,
                scope=scope,
                key=key,
                old_value=old,
                new_value=new,
                actor=actor,
            )
        )


# ---------------------------------------------------------------------------------------------
# Overview board
# ---------------------------------------------------------------------------------------------


async def _summary(t: Tenant) -> dict[str, Any]:
    now = datetime.now(UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    since = now - timedelta(days=QUALITY_DAYS)
    async with tenant_tx("service", t.id) as s:
        people = await s.scalar(select(func.count()).where(Person.deactivated_at.is_(None)))
        roles = await s.scalar(select(func.count()).select_from(RoleNode))
        fates = Counter(
            dict(
                (
                    await s.execute(
                        select(InsightCard.status, func.count())
                        .where(InsightCard.created_at >= since)
                        .group_by(InsightCard.status)
                    )
                ).all()
            )
        )
        open_cards, impact = (
            await s.execute(
                select(func.count(), func.coalesce(func.sum(InsightCard.expected_impact), 0)).where(
                    InsightCard.status == "open"
                )
            )
        ).one()
        last_run = await s.scalar(select(Run).order_by(Run.started_at.desc()).limit(1))
        failed_7d = await s.scalar(
            select(func.count()).where(
                Run.status.in_(("failed", "partial")), Run.started_at > now - timedelta(days=7)
            )
        )
        seconds, tokens = (
            await s.execute(
                select(
                    func.coalesce(func.sum(Run.query_seconds), 0),
                    func.coalesce(func.sum(Run.llm_tokens), 0),
                ).where(Run.started_at >= month_start)
            )
        ).one()
        wc = await s.scalar(select(WarehouseConnection))
        value = await s.scalar(
            select(func.coalesce(func.sum(Outcome.value_captured), 0)).where(Outcome.kind == "end")
        )
        proposed = await s.scalar(select(func.count()).where(FeedbackRule.status == "proposed"))
        pending_invites = await s.scalar(
            select(func.count()).where(Invite.status == "pending", Invite.expires_at > now)
        )
        overrides = await s.scalar(select(func.count()).select_from(RulesConfigRow))
        choice = await effective_choice(s)
        questions = await s.scalar(
            select(func.count()).where(
                OnboardingThread.status == "open", OnboardingThread.waiting_on == "team"
            )
        )
    decided = fates["actioned"] + fates["not_relevant"] + fates["impossible"]
    credits = float(seconds) * XS_CREDITS_PER_SECOND
    cap = float(wc.monthly_credit_cap) if wc else None
    attention = []
    if last_run is not None and last_run.status in ("failed", "partial"):
        attention.append("last run " + last_run.status)
    if failed_7d:
        attention.append(f"{failed_7d} failed or partial runs in 7 days")
    if cap and credits >= 0.8 * cap:
        attention.append("credit use above 80% of cap")
    if decided >= 5 and fates["not_relevant"] / decided > 0.2:
        attention.append("Not relevant above 20%")
    if proposed:
        attention.append(f"{proposed} rules to review")
    if questions:
        attention.append(f"{questions} client question{'s' if questions != 1 else ''} waiting")
    return {
        "id": str(t.id),
        "name": t.name,
        "lifecycle": t.lifecycle,
        "questions_for_team": int(questions or 0),
        "plan": t.plan,
        "locale": t.locale,
        "timezone": t.timezone,
        "currency": t.currency,
        "created_at": t.created_at.isoformat(),
        "people": int(people or 0),
        "roles": int(roles or 0),
        "open_cards": int(open_cards or 0),
        "impact_at_stake": _f(impact),
        "value_captured": _f(value),
        "cards_90d": sum(fates.values()),
        "actioned_rate": fates["actioned"] / decided if decided else None,
        "not_relevant_rate": fates["not_relevant"] / decided if decided else None,
        "last_run": (
            {
                "type": last_run.type,
                "status": last_run.status,
                "started_at": last_run.started_at.isoformat(),
            }
            if last_run
            else None
        ),
        "failed_runs_7d": int(failed_7d or 0),
        "credits_month": round(credits, 4),
        "credit_cap": cap,
        "llm_tokens_month": int(tokens),
        "llm_cost_month_usd": llm_catalog.estimated_cost(choice.model, int(tokens)),
        "llm_model": f"{choice.provider}/{choice.model}",
        "connection": wc.status if wc else "none",
        "rules_to_review": int(proposed or 0),
        "pending_invites": int(pending_invites or 0),
        "config_overrides": int(overrides or 0),
        "health": "attention" if attention else "healthy",
        "attention": attention,
    }


def card_view(c: Any, role: str) -> dict[str, Any]:
    """One card in full, as the role sees it, with the items behind it (ADR 0027, 0028)."""
    ev = c.evidence or {}
    return {
        "id": str(c.id),
        "role": role,
        "title": c.title,
        "status": c.status,
        "what": c.what,
        "so_what": c.so_what,
        "now_what": c.now_what,
        "impact": _f(c.expected_impact),
        "impact_unit": c.impact_unit,
        "confidence": _f(c.confidence),
        "language": c.language,
        "metric": ev.get("metric"),
        "entity": ev.get("entity"),
        "signal_kind": ev.get("signal_kind"),
        "current_value": ev.get("current_value"),
        "baseline_mean": ev.get("baseline_mean"),
        "threshold": ev.get("threshold"),
        "change_vs_baseline_pct": ev.get("change_vs_baseline_pct"),
        "unit": ev.get("unit"),
        "series": ev.get("series", []),
        "top_items": ((ev.get("drivers") or {}).get("top_items")) or [],
    }


async def overview() -> dict[str, Any]:
    workspaces = [await _summary(t) for t in await _tenants()]
    return {
        "totals": {
            "workspaces": len(workspaces),
            "attention": sum(1 for w in workspaces if w["health"] == "attention"),
            "people": sum(w["people"] for w in workspaces),
            "open_cards": sum(w["open_cards"] for w in workspaces),
            "impact_at_stake": round(sum(w["impact_at_stake"] for w in workspaces), 2),
            "value_captured": round(sum(w["value_captured"] for w in workspaces), 2),
            "llm_tokens_month": sum(w["llm_tokens_month"] for w in workspaces),
            "llm_cost_month_usd": round(sum(w["llm_cost_month_usd"] or 0 for w in workspaces), 4),
            "rules_to_review": sum(w["rules_to_review"] for w in workspaces),
        },
        "workspaces": workspaces,
    }


# ---------------------------------------------------------------------------------------------
# One workspace
# ---------------------------------------------------------------------------------------------


async def workspace(tenant_id: uuid.UUID) -> dict[str, Any]:
    t = await _tenant(tenant_id)
    summary = await _summary(t)
    async with tenant_tx("service", tenant_id) as s:
        nodes = await org_repo.nodes(s)
        org = await org_service.org_payload(s, set(nodes))
        runs = (await s.scalars(select(Run).order_by(Run.started_at.desc()).limit(25))).all()
        cards = (
            await s.scalars(
                select(InsightCard)
                .where(InsightCard.status == "open")
                .order_by(InsightCard.expected_impact.desc())
            )
        ).all()
        people = (await s.scalars(select(Person).order_by(Person.name))).all()
        audit = (await s.scalars(select(AuditLog).order_by(AuditLog.at.desc()).limit(30))).all()
    titles = {r["id"]: r["title"] for r in org["roles"]}
    return {
        "summary": summary,
        "org": org,
        "runs": [
            {
                "id": str(r.id),
                "type": r.type,
                "status": r.status,
                "period_end": r.period_end.isoformat(),
                "started_at": r.started_at.isoformat(),
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                "query_seconds": _f(r.query_seconds),
                "llm_tokens": r.llm_tokens,
                "error": r.error,
            }
            for r in runs
        ],
        "cards": [
            {
                "id": str(c.id),
                "role": titles.get(str(c.role_node_id), ""),
                "title": c.title,
                "expected_impact": _f(c.expected_impact),
                "impact_unit": c.impact_unit,
                "signal_kind": (c.evidence or {}).get("signal_kind"),
                "generated_by": c.generated_by,
                "agent": f"{c.agent_key} v{c.agent_version}" if c.agent_key else None,
                "created_at": c.created_at.isoformat(),
            }
            for c in cards
        ],
        "people": [
            {
                "id": str(p.id),
                "name": p.name,
                "email": p.email,
                "app_role": p.app_role,
                "active": p.deactivated_at is None,
            }
            for p in people
        ],
        "audit": [
            {
                "actor": a.actor,
                "action": a.action,
                "object_type": a.object_type,
                "at": a.at.isoformat(),
                "detail": a.detail,
            }
            for a in audit
        ],
    }


async def run_detail(tenant_id: uuid.UUID, run_id: uuid.UUID) -> dict[str, Any]:
    """Run inspector: every step, every AI call with its prompt and answer, every rejection."""
    async with tenant_tx("service", tenant_id) as s:
        run = await s.get(Run, run_id)
        if run is None:
            raise NotFound("run")
        titles = dict((await s.execute(select(RoleNode.id, RoleNode.title))).all())
        steps = (
            await s.scalars(
                select(RunStep).where(RunStep.run_id == run_id).order_by(RunStep.created_at)
            )
        ).all()
        calls = (await s.scalars(select(LlmCallLog).where(LlmCallLog.run_id == run_id))).all()
        rejections = (
            await s.scalars(select(CardRejection).where(CardRejection.run_id == run_id))
        ).all()
        signals = (
            await s.scalars(
                select(Signal).where(Signal.run_id == run_id).order_by(Signal.est_impact.desc())
            )
        ).all()
        cards = (await s.scalars(select(InsightCard).where(InsightCard.run_id == run_id))).all()

    def name(rid: uuid.UUID | None) -> str:
        return str(titles.get(rid, "tenant")) if rid else "tenant"

    view = {
        "run": {
            "id": str(run.id),
            "type": run.type,
            "status": run.status,
            "period_end": run.period_end.isoformat(),
            "started_at": run.started_at.isoformat(),
            "ended_at": run.ended_at.isoformat() if run.ended_at else None,
            "query_seconds": _f(run.query_seconds),
            "llm_tokens": run.llm_tokens,
            "error": run.error,
            "n8n_execution_id": run.n8n_execution_id,
        },
        "steps": [
            {
                "role": name(st.role_node_id),
                "step": st.step,
                "status": st.status,
                "attempts": st.attempts,
                "detail": st.detail,
                "started_at": st.created_at.isoformat(),
                "finished_at": st.finished_at.isoformat() if st.finished_at else None,
            }
            for st in steps
        ],
        "calls": [
            {
                "role": name(c.role_node_id),
                "provider": c.provider,
                "model": c.model,
                "status": c.status,
                "agent": f"{c.agent_key} v{c.agent_version}" if c.agent_key else None,
                "input_tokens": c.input_tokens,
                "output_tokens": c.output_tokens,
                "latency_ms": c.latency_ms,
                "cost_usd": llm_catalog.estimated_cost(c.model, c.input_tokens + c.output_tokens),
                "error": c.error,
                "prompt": c.prompt,
                "response": c.response,
            }
            for c in calls
        ],
        "signals": [
            {
                "role": name(sig.role_node_id),
                "kind": sig.kind,
                "entity": sig.entity,
                "status": sig.status,
                "reason": sig.status_reason,
                "impact": _f(sig.est_impact),
                "zscore": _f(sig.zscore) if sig.zscore is not None else None,
            }
            for sig in signals
        ],
        "rejections": [
            {"role": name(r.role_node_id), "title": r.payload.get("title"), "reasons": r.reasons}
            for r in rejections
        ],
        "cards": [
            {**(v := card_view(c, name(c.role_node_id))), "quality": card_quality.score_card(v)}
            for c in cards
        ],
    }
    view["scorecard"] = scorecard.score_run(view)
    return view


# ---------------------------------------------------------------------------------------------
# Config: system, workspace, role metrics
# ---------------------------------------------------------------------------------------------


async def _system_overrides() -> dict[str, Any]:
    async with global_tx("service") as s:
        return {r.key: r.value for r in await s.scalars(select(SystemConfig))}


async def system_config() -> dict[str, Any]:
    return {"groups": list(cfg.GROUPS), "settings": cfg.describe(await _system_overrides())}


def _check_layer(system: dict[str, Any], workspace: dict[str, Any]) -> None:
    if problems := cfg.check_consistency(cfg.layered(system, workspace)):
        raise Invalid("; ".join(problems))


async def set_system(actor: str, key: str, value: Any) -> dict[str, Any]:
    try:
        clean = cfg.coerce(key, value)
    except ValueError as exc:
        raise Invalid(str(exc)) from exc
    system = await _system_overrides()
    _check_layer({**system, key: clean}, {})
    async with global_tx("service") as s:
        row = await s.get(SystemConfig, key)
        old = row.value if row else None
        if row is None:
            s.add(SystemConfig(key=key, value=clean, updated_by=actor))
        else:
            row.value, row.updated_by, row.updated_at = clean, actor, datetime.now(UTC)
    await _log(actor, "system", key, old, clean)
    return {"status": "ok", "key": key, "value": clean}


async def reset_system(actor: str, key: str) -> dict[str, Any]:
    async with global_tx("service") as s:
        row = await s.get(SystemConfig, key)
        if row is None:
            return {"status": "skipped", "reason": "already the default"}
        old = row.value
        await s.delete(row)
    await _log(actor, "system", key, old, None)
    return {"status": "ok"}


async def workspace_config(tenant_id: uuid.UUID) -> dict[str, Any]:
    await _tenant(tenant_id)
    system = await _system_overrides()
    async with tenant_tx("service", tenant_id) as s:
        workspace_values = await org_repo.workspace_overrides(s)
        rows = (
            await s.execute(
                select(RoleMetric, RoleNode.title, Metric)
                .join(RoleNode, RoleNode.id == RoleMetric.role_node_id)
                .join(Metric, Metric.id == RoleMetric.metric_id)
                .order_by(RoleNode.title, Metric.name)
            )
        ).all()
        metrics = (await s.scalars(select(Metric).order_by(Metric.name))).all()
    return {
        "groups": list(cfg.GROUPS),
        "settings": cfg.describe(system, workspace_values),
        "role_metrics": [
            {
                "id": str(rm.id),
                "role": title,
                "metric": m.name,
                "metric_key": m.key,
                "unit": m.unit,
                "higher_is_better": m.higher_is_better,
                "weight": _f(rm.weight),
                "threshold": _f(rm.threshold) if rm.threshold is not None else None,
                "daily_check": rm.daily_check,
            }
            for rm, title, m in rows
        ],
        "metrics": [
            {
                "id": str(m.id),
                "key": m.key,
                "name": m.name,
                "unit": m.unit,
                "unit_value": _f(m.unit_value),
                "higher_is_better": m.higher_is_better,
                "is_active": m.is_active,
                "template": f"{m.sql_template_key} v{m.sql_template_version}",
            }
            for m in metrics
        ],
    }


async def set_workspace(actor: str, tenant_id: uuid.UUID, key: str, value: Any) -> dict[str, Any]:
    await _tenant(tenant_id)
    try:
        clean = cfg.coerce(key, value)
    except ValueError as exc:
        raise Invalid(str(exc)) from exc
    system = await _system_overrides()
    async with tenant_tx("service", tenant_id) as s:
        current = await org_repo.workspace_overrides(s)
        _check_layer(system, {**current, key: clean})
        row = await s.scalar(select(RulesConfigRow).where(RulesConfigRow.key == key))
        old = row.value if row else None
        if row is None:
            s.add(RulesConfigRow(tenant_id=tenant_id, key=key, value=clean))
        else:
            row.value = clean
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=actor,
                action="config.set",
                object_type="rules_config",
                object_id=key,
                detail={"old": old, "new": clean},
            )
        )
    await _log(actor, "workspace", key, old, clean, tenant_id)
    return {"status": "ok", "key": key, "value": clean}


async def reset_workspace(actor: str, tenant_id: uuid.UUID, key: str) -> dict[str, Any]:
    await _tenant(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        row = await s.scalar(select(RulesConfigRow).where(RulesConfigRow.key == key))
        if row is None:
            return {"status": "skipped", "reason": "no workspace override"}
        old = row.value
        await s.execute(delete(RulesConfigRow).where(RulesConfigRow.key == key))
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=actor,
                action="config.reset",
                object_type="rules_config",
                object_id=key,
                detail={"old": old},
            )
        )
    await _log(actor, "workspace", key, old, None, tenant_id)
    return {"status": "ok"}


def _number(value: Any, label: str, lo: float, hi: float) -> Decimal:
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise Invalid(f"{label} must be a number") from exc
    if not lo <= number <= hi:
        raise Invalid(f"{label} must be between {lo:g} and {hi:g}")
    return Decimal(str(number))


async def set_role_metric(
    actor: str, tenant_id: uuid.UUID, role_metric_id: uuid.UUID, changes: dict[str, Any]
) -> dict[str, Any]:
    await _tenant(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        rm = await s.get(RoleMetric, role_metric_id)
        if rm is None:
            raise NotFound("role metric")
        old = {
            "weight": _f(rm.weight),
            "threshold": _f(rm.threshold) if rm.threshold is not None else None,
            "daily_check": rm.daily_check,
        }
        if "weight" in changes:
            rm.weight = _number(changes["weight"], "weight", 0, 5)
        if "threshold" in changes:
            t = changes["threshold"]
            rm.threshold = None if t is None or t == "" else _number(t, "threshold", -1e9, 1e9)
        if "daily_check" in changes:
            rm.daily_check = bool(changes["daily_check"])
        new = {
            "weight": _f(rm.weight),
            "threshold": _f(rm.threshold) if rm.threshold is not None else None,
            "daily_check": rm.daily_check,
        }
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=actor,
                action="role_metric.updated",
                object_type="role_metric",
                object_id=str(rm.id),
                detail={"old": old, "new": new},
            )
        )
    await _log(actor, "role_metric", str(role_metric_id), old, new, tenant_id)
    return {"status": "ok", **new}


async def set_metric(
    actor: str, tenant_id: uuid.UUID, metric_id: uuid.UUID, changes: dict[str, Any]
) -> dict[str, Any]:
    await _tenant(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        m = await s.get(Metric, metric_id)
        if m is None:
            raise NotFound("metric")
        old = {"unit_value": _f(m.unit_value), "is_active": m.is_active}
        if "unit_value" in changes:
            m.unit_value = _number(changes["unit_value"], "unit value", 0, 1e6)
        if "is_active" in changes:
            m.is_active = bool(changes["is_active"])
        new = {"unit_value": _f(m.unit_value), "is_active": m.is_active}
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=actor,
                action="metric.updated",
                object_type="metric",
                object_id=m.key,
                detail={"old": old, "new": new},
            )
        )
    await _log(actor, "metric", m.key, old, new, tenant_id)
    return {"status": "ok", **new}


async def history(tenant_id: uuid.UUID | None, limit: int = 100) -> list[dict[str, Any]]:
    async with global_tx("service") as s:
        stmt = select(ConfigChange).order_by(ConfigChange.at.desc()).limit(limit)
        stmt = stmt.where(ConfigChange.workspace_id == tenant_id) if tenant_id else stmt
        rows = (await s.scalars(stmt)).all()
        names = {t.id: t.name for t in await s.scalars(select(Tenant))}
    return [
        {
            "scope": r.scope,
            "key": r.key,
            "old": r.old_value,
            "new": r.new_value,
            "actor": r.actor,
            "at": r.at.isoformat(),
            "workspace": names.get(r.workspace_id) if r.workspace_id else None,
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------------------------
# Preview: what would change with these numbers, on the last weekly run, with no writes
# ---------------------------------------------------------------------------------------------


def _selected(decisions: list[Any]) -> dict[str, dict[str, Any]]:
    return {
        d.signal.fingerprint: {
            "entity": d.signal.entity,
            "metric": d.signal.metric_key,
            "kind": d.signal.kind,
            "impact": round(d.signal.est_impact, 2),
        }
        for d in decisions
        # Would reach a card: new (selected) or already carded (suppressed by its open card).
        if d.status == "selected" or (d.status == "suppressed" and d.reason == "open card exists")
    }


async def preview(
    tenant_id: uuid.UUID, overrides: dict[str, Any], role_metric_changes: dict[str, dict[str, Any]]
) -> dict[str, Any]:
    from app.services import pipeline  # import here: pipeline imports a lot

    await _tenant(tenant_id)
    clean = {}
    for key, value in overrides.items():
        try:
            clean[key] = cfg.coerce(key, value)
        except ValueError as exc:
            raise Invalid(str(exc)) from exc
    patch = {}
    for rm_id, change in role_metric_changes.items():
        entry: dict[str, Any] = {}
        if "weight" in change:
            entry["weight"] = _number(change["weight"], "weight", 0, 5)
        if "threshold" in change:
            t = change["threshold"]
            entry["threshold"] = (
                None if t is None or t == "" else _number(t, "threshold", -1e9, 1e9)
            )
        patch[uuid.UUID(rm_id)] = entry
    system = await _system_overrides()
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        run = await s.scalar(
            select(Run)
            .where(Run.type == "weekly", Run.status.in_(("succeeded", "partial")))
            .order_by(Run.started_at.desc())
            .limit(1)
        )
        if run is None or tenant is None:
            raise Invalid("no completed weekly run to preview against yet")
        workspace_values = await org_repo.workspace_overrides(s)
        before_rules = cfg.layered(system, workspace_values)
        after_rules = cfg.layered(system, {**workspace_values, **clean})
        if problems := cfg.check_consistency(after_rules):
            raise Invalid("; ".join(problems))
        roles = (
            await s.execute(
                select(RoleNode.id, RoleNode.title)
                .where(RoleNode.id.in_(select(RoleMetric.role_node_id)))
                .order_by(RoleNode.title)
            )
        ).all()
        out = []
        for role_id, title in roles:
            before, _ = await pipeline.detect_role(s, tenant, run.id, role_id, before_rules)
            after, _ = await pipeline.detect_role(s, tenant, run.id, role_id, after_rules, patch)
            b, a = _selected(before), _selected(after)
            out.append(
                {
                    "role": title,
                    "before": len(b),
                    "after": len(a),
                    "added": [a[k] for k in a.keys() - b.keys()],
                    "removed": [b[k] for k in b.keys() - a.keys()],
                    "kept": len(a.keys() & b.keys()),
                }
            )
    return {"run_id": str(run.id), "period_end": run.period_end.isoformat(), "roles": out}


# ---------------------------------------------------------------------------------------------
# Rules across workspaces
# ---------------------------------------------------------------------------------------------


async def all_rules(status: str | None) -> list[dict[str, Any]]:
    from app.services import feedback  # avoid a cycle (feedback imports agents)

    out = []
    for t in await _tenants():
        for r in await feedback.rules_for_workspace(t.id):
            if status and r["status"] != status:
                continue
            out.append({**r, "workspace_id": str(t.id), "workspace": t.name})
    return out


# ---------------------------------------------------------------------------------------------
# Feedback insights (ADR 0025): what a workspace keeps rejecting, per metric, entity and writer
# ---------------------------------------------------------------------------------------------


async def feedback_insights(tenant_id: uuid.UUID) -> dict[str, Any]:
    await _tenant(tenant_id)
    since = datetime.now(UTC) - timedelta(days=QUALITY_DAYS)
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
        titles = dict((await s.execute(select(RoleNode.id, RoleNode.title))).all())
        cards = (await s.scalars(select(InsightCard).where(InsightCard.created_at >= since))).all()
        feedback = (
            await s.execute(
                select(Feedback, InsightCard, Person.name)
                .join(InsightCard, InsightCard.id == Feedback.card_id)
                .join(Person, Person.id == Feedback.person_id)
                .where(Feedback.created_at >= since)
                .order_by(Feedback.created_at.desc())
            )
        ).all()
        rejections = (
            await s.execute(
                select(CardRejection, LlmCallLog.agent_key, LlmCallLog.agent_version)
                .outerjoin(
                    LlmCallLog,
                    (LlmCallLog.run_id == CardRejection.run_id)
                    & (LlmCallLog.role_node_id == CardRejection.role_node_id),
                )
                .where(CardRejection.created_at >= since)
            )
        ).all()

    by_metric: dict[tuple[str, str], Counter[str]] = {}
    for c in cards:
        key = (titles.get(c.role_node_id, ""), str((c.evidence or {}).get("metric", "")))
        by_metric.setdefault(key, Counter())[c.status] += 1
    fates = [
        fb_rules.MetricFate(role, metric, n["actioned"], n["not_relevant"], n["impossible"])
        for (role, metric), n in by_metric.items()
    ]

    entities: Counter[tuple[str, str, str]] = Counter()
    for f, card, _name in feedback:
        entities[
            (
                titles.get(card.role_node_id, ""),
                str((card.evidence or {}).get("entity", "")),
                f.type,
            )
        ] += 1

    written: Counter[str] = Counter()
    for c in cards:
        if c.agent_key:
            written[f"{c.agent_key} v{c.agent_version}"] += 1
    refused: Counter[str] = Counter()
    reasons_by_agent: dict[str, Counter[str]] = {}
    by_category: Counter[tuple[str, str]] = Counter()
    for r, agent_key, agent_version in rejections:
        agent = f"{agent_key} v{agent_version}" if agent_key else "no agent"
        refused[agent] += 1
        for reason in r.reasons:
            category = fb_rules.rejection_category(reason)
            reasons_by_agent.setdefault(agent, Counter())[category] += 1
            by_category[(titles.get(r.role_node_id, ""), category)] += 1
    writers = [
        fb_rules.WriterQuality(
            agent,
            written[agent] + refused[agent],
            refused[agent],
            reasons_by_agent[agent].most_common(1)[0][0] if agent in reasons_by_agent else None,
        )
        for agent in set(written) | set(refused)
    ]

    return {
        "since_days": QUALITY_DAYS,
        "hints": fb_rules.hints(fates, writers, rules),
        "metrics": sorted(
            [
                {
                    "role": f.role,
                    "metric": f.metric,
                    "shown": sum(by_metric[(f.role, f.metric)].values()),
                    "actioned": f.actioned,
                    "not_relevant": f.not_relevant,
                    "impossible": f.impossible,
                    "expired": by_metric[(f.role, f.metric)]["expired"],
                    "open": by_metric[(f.role, f.metric)]["open"],
                    "not_relevant_rate": f.not_relevant / f.decided if f.decided else None,
                }
                for f in fates
            ],
            key=lambda m: (-(m["not_relevant"] + m["impossible"]), m["role"]),
        ),
        "entities": [
            {"role": role, "entity": entity, "type": kind, "count": n}
            for (role, entity, kind), n in entities.most_common(12)
        ],
        "writers": sorted(
            [
                {
                    "agent": w.agent,
                    "written": w.written,
                    "rejected": w.rejected,
                    "rejection_rate": w.rejected / w.written if w.written else None,
                    "top_reason": w.top_reason,
                }
                for w in writers
            ],
            key=lambda w: -(w["rejection_rate"] or 0),
        ),
        "rejections": [
            {"role": role, "category": category, "count": n}
            for (role, category), n in by_category.most_common()
        ],
        "recent": [
            {
                "role": titles.get(card.role_node_id, ""),
                "card": card.title,
                "type": f.type,
                "reason": f.reason,
                "by": name,
                "at": f.created_at.isoformat(),
            }
            for f, card, name in feedback[:25]
        ],
    }
