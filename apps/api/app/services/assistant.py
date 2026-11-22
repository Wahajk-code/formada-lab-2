"""Ask the AI about one workspace (ADR 0027): the internal team gets answers with the full
onboarding context; the client gets plain answers and, on the metrics and rules steps,
suggestions they can send to our team. Shape only: the context holds the data guide, links,
org web, measures and rules, never rows. Stateless: the caller sends the recent turns."""

import json
import uuid
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import select

from app.core.auth import Principal
from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Forbidden, Invalid
from app.core.logging import get_logger
from app.domain import grounding
from app.domain import onboarding as ob
from app.domain import onboarding_flow as flow
from app.domain.config import SCHEMA, coerce
from app.domain.llm import PRICES, estimated_cost
from app.integrations.llm import get_llm
from app.models import (
    ArchetypeMapping,
    DataArchetype,
    Metric,
    OnboardingSignoff,
    OnboardingStep,
    OnboardingThread,
    Person,
    RoleMetric,
    RoleNode,
    SqlTemplate,
    Tenant,
)
from app.repositories import agents as agent_repo
from app.repositories import org as org_repo
from app.services import onboarding_collab as collab
from app.services.agents import _choice

log = get_logger(__name__)
AGENT = "workspace_assistant"
STYLE = [
    "Answer the question that was asked, first, and stay on its topic. Do not describe parts of "
    "the context the question did not ask about.",
    "Use plain everyday words. Name a table or field only when it is needed to be understood.",
    "If the person asks you to simplify or explain simply, drop field names and technical terms "
    "and use at most four short points, each one plain sentence.",
    "Everything the system knew when it made the data guide is in the context: warehouse_profile "
    "(every table and field, dates, categories, the customer's semantic views), data_guide, "
    "links (the mapping), standard_model and ai_cost (what each step cost, and what runs cost "
    "after go-live). Look there before saying something is missing.",
    "State only decisions and handling that the context states. If you suggest something the "
    'context does not say, call it "my suggestion" so it is not mistaken for the guide.',
    "When mentioned_cards is in the context, the person attached those cards, links or fields with "
    "@: words like it, this, that or these mean them. Answer about exactly those first, using "
    "everything given for each one. If mentions_not_found is in the context, say which ones you "
    "could not read instead of guessing what was meant.",
    "If the question is too vague to answer and nothing is attached, do not stop at asking: say "
    "what you can see in the current step (the open decisions, the low-confidence items) and offer "
    "the two or three most likely things they may mean.",
    "If the context really does not contain the answer, say so in one sentence and say who can "
    "answer.",
]
QUESTION_MAX = 2000
HISTORY_TURNS = 20
CONTEXT_LIMIT = 450_000  # characters; past this the largest parts are slimmed (see _fit)
# Settings a client may suggest; the rest stay with our team.
CLIENT_RULE_KEYS = (
    "max_open_cards_per_role",
    "card_expiry_days",
    "min_signal_impact",
    "top_signals_per_role",
    "top_items_per_problem",
    "not_relevant_suppress_days",
    "rollup_top_n",
)


class Turn(BaseModel):
    role: Literal["user", "assistant"]
    text: str


class MetricIdea(BaseModel):
    name: str
    template: str
    roles: list[str]
    alert: str
    why: str


class RuleIdea(BaseModel):
    key: str
    value: float
    why: str


class AssistantOut(BaseModel):
    answer: str
    # Which parts of the context the answer used ("links", "data_guide.issues", ...), and
    # whether the context held the answer: yes, partly, or no (then the answer says so).
    sources: list[str] = []
    grounded: Literal["yes", "partly", "no"] = "yes"
    metric_suggestions: list[MetricIdea]
    rule_suggestions: list[RuleIdea]


def _check(out: AssistantOut, ctx: dict[str, Any], language: str = "en") -> dict[str, Any]:
    """What the UI shows under an answer: its sources and the numbers code could not find."""
    return {
        "sources": grounding.known_sources(out.sources, ctx),
        "grounded": out.grounded,
        "unverified": grounding.unsupported_numbers(out.answer, ctx, language),
    }


def _trim(text: Any, n: int = 600) -> Any:
    return text[:n] if isinstance(text, str) else text


async def _latest_outputs(s: Any) -> dict[str, dict[str, Any]]:
    rows = (
        await s.scalars(
            select(OnboardingStep)
            .where(OnboardingStep.status.in_(("proposed", "approved")))
            .order_by(OnboardingStep.created_at.desc())
        )
    ).all()
    out: dict[str, dict[str, Any]] = {}
    for r in rows:
        if r.step not in out and r.output and not r.output.get("raw"):
            out[r.step] = {"status": r.status, "output": r.output, "checks": r.checks}
    return out


async def _templates(maps: set[str]) -> list[dict[str, Any]]:
    async with global_tx("service") as s:
        rows = (await s.scalars(select(SqlTemplate))).all()
    latest: dict[str, SqlTemplate] = {}
    for t in rows:
        if t.key not in latest or t.version > latest[t.key].version:
            latest[t.key] = t
    return [
        {"template": t.key, "description": " ".join(t.description.split())}
        for t in latest.values()
        if set(t.aliases.values()) <= maps
    ]


# What running Formada costs once a customer is live, measured on the demo data (docs/llm-costs.md,
# 2026-10-28). One weekly run asks the model once per role that has signals.
COST_REFERENCE: dict[str, Any] = {
    "measured": "2026-10-28 on the Whaaj demo data, one weekly run of 4 roles",
    "cost_per_weekly_run_usd": {"claude-haiku-5-5": 0.0024, "claude-sonnet-5-5": 0.040},
    "cost_per_role_per_run_usd": {
        "claude-haiku-5-5": "0.0004 to 0.0008",
        "claude-sonnet-5-5": "0.008 to 0.014",
    },
    "projected_per_month_usd": {
        "weekly runs, 4 roles": {"claude-haiku-5-5": 0.01, "claude-sonnet-5-5": 0.17},
        "weekly runs, 30 roles": {"claude-haiku-5-5": 0.08, "claude-sonnet-5-5": 1.30},
        "weekly runs plus daily checks, 4 roles": {
            "claude-haiku-5-5": 0.08,
            "claude-sonnet-5-5": 1.40,
        },
        "weekly runs plus daily checks, 30 roles": {
            "claude-haiku-5-5": 0.60,
            "claude-sonnet-5-5": 10,
        },
    },
    "notes": (
        "Haiku is the default card writer: about 17 times cheaper than Sonnet and it followed "
        "the numbers-only rule better. Roles with no signals never call the model. Daily "
        "checks cost nothing when the roles already have open cards for the same signals."
    ),
}


def _cost_structure(rows: list[Any]) -> dict[str, Any]:
    """What the onboarding AI has cost this workspace so far: per step and per run, with tokens,
    model and speed, and the price table behind it. Chat questions are not counted."""
    runs: list[dict[str, Any]] = []
    by_step: dict[str, dict[str, Any]] = {}
    models: set[str] = set()
    total = 0.0
    for r in rows:
        tokens = (r.input_tokens or 0) + (r.output_tokens or 0)
        cost = estimated_cost(r.model or "", tokens) or 0.0
        total += cost
        models.add(r.model or "")
        step = by_step.setdefault(
            r.step,
            {"runs": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0, "seconds": 0.0},
        )
        step["runs"] += 1
        step["input_tokens"] += r.input_tokens or 0
        step["output_tokens"] += r.output_tokens or 0
        step["cost_usd"] = round(step["cost_usd"] + cost, 4)
        step["seconds"] = round(step["seconds"] + (r.latency_ms or 0) / 1000, 1)
        runs.append(
            {"step": r.step, "status": r.status, "agent": f"{r.agent_key} v{r.agent_version}",
             "model": r.model, "input_tokens": r.input_tokens, "output_tokens": r.output_tokens,
             "seconds": round((r.latency_ms or 0) / 1000, 1), "cost_usd": cost,
             "at": r.created_at.isoformat()}
        )  # fmt: skip
    return {
        "total_usd": round(total, 4),
        "by_step": by_step,
        "runs_latest_40": runs[-40:],
        "price_per_million_tokens_usd": {
            m: {"input": PRICES[m][0], "output": PRICES[m][1]}
            for m in sorted(models)
            if m in PRICES
        },
        "how_calculated": (
            "Estimated from tokens at the model's price per million tokens, assuming 80% of "
            "tokens are input: the same figure the console shows. Real billing can differ a "
            "little."
        ),
        "not_included": "Chat questions and suggestions to this assistant are not tracked here.",
        "after_go_live": COST_REFERENCE,
    }


def _connections(profile: dict[str, Any]) -> dict[str, Any]:
    """The measured results about how tables connect, kept together and easy to find: the joins we
    tested on the data (share of values that match) and whether item codes match between areas.
    The customer's own view links are in warehouse_profile."""
    tested = [
        {"from": j.get("source"), "to": j.get("target"), "confirmed": j.get("confirmed"),
         "matched_pct": j.get("matched_pct"), "values_without_match": j.get("orphan_values")}
        for j in (profile.get("joins") or [])[:30]
    ]  # fmt: skip
    overlaps = [
        {"left": o.get("left"), "right": o.get("right"), "matching_pct": o.get("pct_of_right")}
        for o in (profile.get("key_overlaps") or [])[:10]
    ]  # fmt: skip
    found: dict[str, Any] = {}
    if tested:
        found["tested_joins"] = tested
    if overlaps:
        found["item_code_matches"] = overlaps
    return found


def _fit(ctx: dict[str, Any], limit: int = CONTEXT_LIMIT) -> dict[str, Any]:
    """Keep the context under a size limit for very large warehouses. Everything is kept for a
    normal one. When it is too big, the least useful detail goes first, step by step, and
    `context_trimmed` says what was cut so the assistant can tell the person."""
    profile: dict[str, Any] = ctx.get("warehouse_profile") or {}
    view_tables = [t for v in profile.get("semantic_views", []) for t in v.get("tables", [])]

    def drop_field_descriptions() -> None:
        for t in view_tables:
            for d in t.get("dimensions", []):
                d.pop("comment", None)

    def drop_field_lists() -> None:
        for t in view_tables:
            t.pop("dimensions", None)

    def cap_fields() -> None:
        for t in profile.get("tables", []):
            t["columns"] = t.get("columns", [])[:40]

    def drop_daily_counts() -> None:
        (profile.get("time_profile") or {}).pop("by_date", None)
        profile.pop("name_keywords", None)

    steps = (
        ("the customer's field descriptions", drop_field_descriptions),
        ("the customer's field lists (measures are kept)", drop_field_lists),
        ("fields beyond 40 per table", cap_fields),
        ("daily row counts and name keywords", drop_daily_counts),
    )
    cut: list[str] = []
    for name, act in steps:
        if len(json.dumps(ctx, default=str, separators=(",", ":"))) <= limit:
            break
        act()
        cut.append(name)
    if cut:
        ctx["context_trimmed"] = (
            "This warehouse is very large, so these were left out: " + "; ".join(cut)
        )
    return ctx


async def _standard_model() -> list[dict[str, Any]]:
    """The shapes Formada maps every warehouse onto, with what each field means."""
    async with global_tx("service") as s:
        rows = (await s.scalars(select(DataArchetype).order_by(DataArchetype.key))).all()
    return [
        {"archetype": a.key, "description": a.description, "grain": list(ob.GRAIN.get(a.key, [])),
         "fields": [{"field": k, "meaning": v} for k, v in a.columns.items()]}
        for a in rows
    ]  # fmt: skip


async def _team_context(tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        steps = await _latest_outputs(s)
        roles = (await s.scalars(select(RoleNode))).all()
        metrics = (await s.scalars(select(Metric))).all()
        rules = await org_repo.rules(s)
        threads = (
            await s.scalars(select(OnboardingThread).where(OnboardingThread.status == "open"))
        ).all()
        p = await collab._progress(s, tenant) if tenant else None
        disc = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == "discovery", OnboardingStep.output.is_not(None))
            .order_by(OnboardingStep.created_at.desc())
            .limit(1)
        )
        spent = (
            await s.scalars(
                select(OnboardingStep)
                .where(OnboardingStep.model.is_not(None))
                .order_by(OnboardingStep.created_at)
            )
        ).all()
    disc_in = (disc.input or {}) if disc else {}
    profile = disc_in.get("profile") or {}
    ctx: dict[str, Any] = {
        "workspace": tenant.name if tenant else "",
        "currency": tenant.currency if tenant else "",
        "progress": flow.team_steps(p) if p else [],
        "open_questions": [
            {"step": t.step, "title": t.title, "waiting_on": t.waiting_on} for t in threads
        ],
        "roles": [{"title": r.title, "role_type": r.role_archetype_key} for r in roles],
        "measures_live": [
            {
                "name": m.name,
                "template": m.sql_template_key,
                "unit": m.unit,
                "money_per_unit": float(m.unit_value),
            }
            for m in metrics
        ],
        "rules": {k: getattr(rules, k) for k in SCHEMA},
        "ai_cost": _cost_structure(list(spent)),
    }
    d = steps.get("discovery", {}).get("output")
    if d:
        # The whole data guide, as written, with the team's open and locked state.
        ctx["data_guide"] = {
            **{k: d.get(k) for k in ("summary", "cadence", "tables", "semantic_views", "coverage",
                                     "quality_issues", "questions")},
            "cards_open_for_changes": d.get("unlocked_cards", []),
            "relationships_the_team_removed": d.get("removed_joins", []),
        }  # fmt: skip
        ctx["data_guide"].update(_connections(profile))
    if profile:
        # Everything the guide was made from: every table and field with type, how complete it is
        # and distinct counts, dates and cadence, category values, and the customer's semantic
        # views with their fields, measures, formulas, descriptions and links. Never rows.
        ctx["warehouse_profile"] = {k: v for k, v in profile.items() if k != "privacy"}
        ctx["how_the_guide_was_made"] = {
            "instructions_from_the_team": disc_in.get("team_notes") or "",
            "analyst": (
                f"{disc.agent_key} v{disc.agent_version}" if disc and disc.agent_key else None
            ),
            "made_at": disc.created_at.isoformat() if disc else None,
        }
        ctx["standard_model"] = await _standard_model()
    m = steps.get("mapping")
    if m:
        checks = (m.get("checks") or {}).get("archetypes", {})
        ctx["links"] = [
            {"standard_shape": a["archetype"], "status": a["status"], "filters": a.get("filters"),
             "questions": a.get("questions"),
             "rows": checks.get(a["archetype"], {}).get("rows"),
             "passes_live_test": checks.get(a["archetype"], {}).get("ok"),
             "live_test_details": checks.get(a["archetype"]),
             "fields": [{"field": f["field"], "from": f["source_columns"],
                         "confidence": f["confidence"], "how": f.get("expression"),
                         "why": f.get("reason")}
                        for f in a.get("fields", [])],
             "sql": a.get("source_sql")}
            for a in m["output"].get("archetypes", [])
        ]  # fmt: skip
    for key in ("org", "metrics", "rules"):
        if key in steps:
            ctx[f"{key}_proposal"] = {"status": steps[key]["status"], **steps[key]["output"]}
    return _fit(ctx)


async def _client_context(principal: Principal, step: str) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me: Person | None = await s.get(Person, principal.person_id)
        if me is None or me.app_role not in collab.ADMIN_ROLES:
            raise Forbidden("only workspace owners and admins take part in onboarding")
        tenant = await s.get(Tenant, principal.tenant_id)
        assert tenant is not None
        p = await collab._progress(s, tenant)
        if not flow.is_open(p, step):
            raise Conflict("this step is not open yet")
        signs = (await s.scalars(select(OnboardingSignoff))).all()
        roles = (await s.scalars(select(RoleNode))).all()
        titles = {r.id: r.title for r in roles}
        watched = (
            await s.execute(select(Metric.name, RoleMetric.role_node_id, RoleMetric.threshold)
                            .join(RoleMetric, RoleMetric.metric_id == Metric.id))
        ).all()  # fmt: skip
        maps = {m.archetype_key for m in await s.scalars(select(ArchetypeMapping))}
        rules = await org_repo.rules(s)
    ctx: dict[str, Any] = {
        "workspace": tenant.name,
        "currency": tenant.currency,
        "current_step": step,
        "approved_so_far": {x.step: x.summary for x in signs if x.team_at},
        "roles": sorted(titles.values()),
        "measures_now": [
            {"measure": n, "role": titles.get(r), "alert_at": float(t) if t else None}
            for n, r, t in watched
        ],
    }
    if step == "metrics":
        ctx["measure_types_available"] = await _templates(maps)
    if step == "rules":
        ctx["rule_settings"] = [
            {"key": k, "label": SCHEMA[k].label, "meaning": SCHEMA[k].help,
             "now": getattr(rules, k), "min": SCHEMA[k].minimum, "max": SCHEMA[k].maximum,
             "unit": SCHEMA[k].unit}
            for k in CLIENT_RULE_KEYS
        ]  # fmt: skip
    return ctx


def _history(history: list[Turn]) -> str:
    return "\n".join(f"{t.role}: {t.text[:4000]}" for t in history[-HISTORY_TURNS:])


async def _call(
    tenant_id: uuid.UUID, side: str, step: str, question: str, ctx: dict[str, Any],
    history: list[Turn],
) -> AssistantOut:  # fmt: skip
    question = question.strip()
    if not question:
        raise Invalid("ask a question")
    if len(question) > QUESTION_MAX:
        raise Invalid(f"keep questions under {QUESTION_MAX} characters")
    async with tenant_tx("service", tenant_id) as s:
        found = await agent_repo.active(s, AGENT)
        if found is None:
            raise Conflict(f"agent {AGENT} is not loaded: run make seed")
        agent, prompt = found
        choice = await _choice(s, agent)
    user = json.dumps(
        {"asker": side, "step": step, "context": ctx, "conversation": _history(history),
         "answer_style": STYLE, "question": question},
        ensure_ascii=False, default=str, separators=(",", ":"),
    )  # fmt: skip
    fake = AssistantOut(answer="(local fake model) " + question, metric_suggestions=[],
                        rule_suggestions=[])  # fmt: skip
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body, user, AssistantOut, fake=fake, effort="low", timeout_s=180
    )
    log.info("assistant.answer", side=side, step=step, model=result.model,
             tokens=result.input_tokens + result.output_tokens)  # fmt: skip
    if result.parsed is None:
        raise Conflict(f"the AI could not answer: {result.error or 'no answer'}")
    out = result.parsed
    assert isinstance(out, AssistantOut)
    return out


def unread_mentions(asked: list[str], found: list[dict[str, Any]]) -> list[str]:
    """Attached items the API could not read. A block (g:) names many cards and counts as read."""
    have = {str(c.get("card") or c.get("fact")) for c in found}
    return [c for c in asked if not c.startswith("g:") and c not in have]


def mapping_mentions(links: list[dict[str, Any]], ids: list[str]) -> list[dict[str, Any]]:
    """The mapping links the team mentioned: `m:<shape>` is a whole link, `m:<shape>.<field>` one
    field of it (with the link's filters and questions, so the answer has its context)."""
    found: list[dict[str, Any]] = []
    by_shape = {str(a.get("standard_shape")): a for a in links}
    for mid in ids:
        shape, _, field = mid[2:].partition(".")
        link = by_shape.get(shape)
        if link is None:
            continue
        if not field:
            found.append({"card": mid, **link})
            continue
        match = next((f for f in link.get("fields", []) if f.get("field") == field), None)
        if match:
            found.append(
                {"card": mid, "standard_shape": shape, "field": match,
                 "filters": link.get("filters"), "questions": link.get("questions")}
            )  # fmt: skip
    return found


async def team_ask(
    tenant_id: uuid.UUID, step: str, question: str, history: list[Turn],
    cards: list[str] | None = None,
) -> dict[str, Any]:  # fmt: skip
    ctx = await _team_context(tenant_id)
    missing: list[str] = []
    if cards:
        from app.services import onboarding_items

        # Cards the team mentioned with @: the chat answers about exactly these. Mapping links
        # (m:) come from the mapping already in the context; the rest from discovery.
        found = mapping_mentions(ctx.get("links") or [], [c for c in cards if c.startswith("m:")])
        rest = [c for c in cards if not c.startswith("m:")]
        if rest:
            found += await onboarding_items.card_context(tenant_id, rest)
        ctx["mentioned_cards"] = found
        missing = unread_mentions(cards, found)
        if missing:
            ctx["mentions_not_found"] = missing
    out = await _call(tenant_id, "team", step, question, ctx, history)
    return {"answer": out.answer, **_check(out, ctx), "mentions_missing": missing}


async def client_ask(
    principal: Principal, step: str, question: str, history: list[Turn]
) -> dict[str, Any]:
    ctx = await _client_context(principal, step)
    out = await _call(principal.tenant_id, "client", step, question, ctx, history)
    allowed = {t["template"] for t in ctx.get("measure_types_available", [])}
    metrics = [m.model_dump() for m in out.metric_suggestions if m.template in allowed]
    rules = []
    for r in out.rule_suggestions:
        if r.key not in CLIENT_RULE_KEYS:
            continue
        try:
            value = coerce(r.key, r.value)
        except ValueError:
            continue
        rules.append({"key": r.key, "label": SCHEMA[r.key].label, "value": value,
                      "unit": SCHEMA[r.key].unit, "why": r.why})  # fmt: skip
    return {
        "answer": out.answer,
        **_check(out, ctx, principal.locale),
        "metric_suggestions": metrics if step == "metrics" else [],
        "rule_suggestions": rules if step == "rules" else [],
    }


async def client_send(
    principal: Principal, step: str, metrics: list[dict[str, Any]], rules: list[dict[str, Any]],
    note: str,
) -> dict[str, Any]:  # fmt: skip
    """The client sends chosen suggestions to our team as a question on the step."""
    lines = []
    for m in metrics[:20]:
        roles = ", ".join(str(r) for r in m.get("roles", []))
        lines.append(f"- Watch: {m.get('name')} (for {roles}; alert: {m.get('alert')}). "
                     f"Why: {m.get('why')}")  # fmt: skip
    for r in rules[:20]:
        if r.get("key") not in CLIENT_RULE_KEYS:
            continue
        lines.append(f"- {SCHEMA[r['key']].label}: {r.get('value')} {SCHEMA[r['key']].unit}. "
                     f"Why: {r.get('why')}")  # fmt: skip
    if not lines:
        raise Invalid("choose at least one suggestion")
    body = (note.strip() + "\n\n" if note.strip() else "") + "\n".join(lines)
    title = "Suggested measures" if step == "metrics" else "Suggested rules"
    return await collab.client_ask(principal, step, title, body)
