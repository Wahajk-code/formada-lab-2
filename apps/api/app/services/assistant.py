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
from app.domain import onboarding_flow as flow
from app.domain.config import SCHEMA, coerce
from app.integrations.llm import get_llm
from app.models import (
    ArchetypeMapping,
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
QUESTION_MAX = 2000
HISTORY_TURNS = 8
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
    }
    d = steps.get("discovery", {}).get("output")
    if d:
        ctx["data_guide"] = {
            "summary": d.get("summary"), "cadence": d.get("cadence"),
            "tables": [{k: t.get(k) for k in ("table", "kind", "grain", "purpose", "key_columns")}
                       for t in d.get("tables", [])],
            "coverage": d.get("coverage"),
            "issues": [{k: q.get(k) for k in ("title", "severity", "impact", "suggested_handling")}
                       for q in d.get("quality_issues", [])],
        }  # fmt: skip
    m = steps.get("mapping")
    if m:
        checks = (m.get("checks") or {}).get("archetypes", {})
        ctx["links"] = [
            {"standard_shape": a["archetype"], "status": a["status"], "filters": a.get("filters"),
             "rows": checks.get(a["archetype"], {}).get("rows"),
             "passes_live_test": checks.get(a["archetype"], {}).get("ok"),
             "fields": [{"field": f["field"], "from": f["source_columns"],
                         "confidence": f["confidence"], "how": _trim(f.get("expression"), 200)}
                        for f in a.get("fields", [])],
             "sql": _trim(a.get("source_sql"), 1500)}
            for a in m["output"].get("archetypes", [])
        ]  # fmt: skip
    for key in ("org", "metrics", "rules"):
        if key in steps:
            ctx[f"{key}_proposal"] = {"status": steps[key]["status"], **steps[key]["output"]}
    return ctx


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
    return "\n".join(f"{t.role}: {t.text[:1500]}" for t in history[-HISTORY_TURNS:])


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
         "question": question},
        ensure_ascii=False, default=str,
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


async def team_ask(
    tenant_id: uuid.UUID, step: str, question: str, history: list[Turn]
) -> dict[str, Any]:
    ctx = await _team_context(tenant_id)
    out = await _call(tenant_id, "team", step, question, ctx, history)
    return {"answer": out.answer, **_check(out, ctx)}


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
