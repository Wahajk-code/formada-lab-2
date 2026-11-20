"""AI help in the console (ADR 0029): it suggests, our team decides.

Three jobs, one agent (console_advisor):
- settings: suggest values for business rules, system-wide or for one workspace, from the
  team's goal and the workspace's own numbers. Suggestions fill the editor; nothing is saved
  until someone presses Save, and every value is checked against its range first.
- prompt: draft a new version of an agent's instructions from the team's request. The draft
  fills the editor; a version is only created, and only goes live, by hand.
- measures: suggest measures to add to a live workspace, from templates it can run.
"""

import json
import uuid
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select

from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.logging import get_logger
from app.domain import config as cfg
from app.integrations.llm import get_llm
from app.models import Agent, AgentPrompt, Metric, RoleNode, Tenant
from app.repositories import agents as agent_repo
from app.services import console
from app.services import onboarding as ob_svc
from app.services.agents import _choice

log = get_logger(__name__)
AGENT = "console_advisor"
GOAL_MAX = 2000


class SettingIdea(BaseModel):
    key: str
    value: float
    why: str


class SettingsAdvice(BaseModel):
    summary: str
    suggestions: list[SettingIdea]


class PromptDraft(BaseModel):
    body: str
    notes: str


class MeasureIdea(BaseModel):
    template: str
    name: str
    roles: list[str]
    alert: str
    why: str


class MeasureAdvice(BaseModel):
    summary: str
    suggestions: list[MeasureIdea]


async def _ask(
    task: str, goal: str, context: dict[str, Any], schema: type[BaseModel], fake: BaseModel
) -> Any:
    goal = goal.strip()
    if len(goal) > GOAL_MAX:
        raise Invalid(f"keep it under {GOAL_MAX} characters")
    async with global_tx("service") as s:
        found = await agent_repo.active(s, AGENT)
        if found is None:
            raise Conflict(f"agent {AGENT} is not loaded: run make seed")
        agent, prompt = found
        choice = await _choice(s, agent)
    user = json.dumps(
        {"task": task, "goal": goal, "context": context}, ensure_ascii=False, default=str
    )
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body, user, schema, fake=fake, effort="low", timeout_s=180
    )
    log.info(
        "console_ai",
        task=task,
        model=result.model,
        tokens=result.input_tokens + result.output_tokens,
    )
    if result.parsed is None:
        raise Conflict(f"the AI could not answer: {result.error or 'no answer'}")
    return result.parsed


# ---- settings --------------------------------------------------------------------------------


async def suggest_settings(tenant_id: uuid.UUID | None, goal: str) -> dict[str, Any]:
    system = await console._system_overrides()
    if tenant_id is None:
        rows = cfg.describe(system)
        stats: dict[str, Any] = {
            "scope": "system, every workspace",
            "totals": (await console.overview())["totals"],
        }
    else:
        tenant = await console._tenant(tenant_id)
        rows = (await console.workspace_config(tenant_id))["settings"]
        insights = await console.feedback_insights(tenant_id)
        stats = {
            "scope": f"one workspace: {tenant.name}",
            "summary": await console._summary(tenant),
            "hints": insights.get("hints", []),
        }
    settings = [
        {
            k: r[k]
            for k in ("key", "label", "simple", "help", "unit", "min", "max", "effective", "source")
        }
        for r in rows
        if r["group"] != "access"
    ]
    out: SettingsAdvice = await _ask(
        "settings",
        goal,
        {"settings": settings, "stats": stats},
        SettingsAdvice,
        SettingsAdvice(summary="(local fake model)", suggestions=[]),
    )
    current = {r["key"]: r["effective"] for r in rows}
    clean = []
    for idea in out.suggestions[:8]:
        meta = cfg.SCHEMA.get(idea.key)
        if meta is None or meta.group == "access":
            continue
        try:
            value = cfg.coerce(idea.key, idea.value)
        except ValueError:
            continue
        if value == current.get(idea.key):
            continue
        clean.append(
            {
                "key": idea.key,
                "label": meta.label,
                "value": value,
                "now": current.get(idea.key),
                "unit": meta.unit,
                "why": idea.why,
            }
        )
    return {"summary": out.summary, "suggestions": clean}


# ---- agent instructions ----------------------------------------------------------------------


async def draft_prompt(key: str, instruction: str) -> dict[str, Any]:
    if not instruction.strip():
        raise Invalid("say what should change")
    async with global_tx("service") as s:
        agent = await s.get(Agent, key)
        if agent is None:
            raise NotFound("agent")
        prompt = await s.scalar(
            select(AgentPrompt).where(
                AgentPrompt.agent_key == key, AgentPrompt.version == agent.active_version
            )
        )
    if prompt is None:
        raise NotFound("agent prompt")
    out: PromptDraft = await _ask(
        "prompt",
        instruction,
        {
            "agent": {
                "key": agent.key,
                "name": agent.name,
                "kind": agent.kind,
                "description": agent.description,
            },
            "current_version": agent.active_version,
            "current_body": prompt.body,
        },
        PromptDraft,
        PromptDraft(body=prompt.body, notes="(local fake model) unchanged"),
    )
    return {"body": out.body, "notes": out.notes, "from_version": agent.active_version}


# ---- measures --------------------------------------------------------------------------------


async def suggest_measures(tenant_id: uuid.UUID, goal: str) -> dict[str, Any]:
    await console._tenant(tenant_id)
    templates, _ = await ob_svc._feedable_templates(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        roles = (await s.scalars(select(RoleNode))).all()
        used = {m.sql_template_key for m in await s.scalars(select(Metric).where(Metric.is_active))}
    context = {
        "templates": [
            {"key": t.key, "description": t.description, "playbook": t.playbook}
            for t in templates
            if t.key not in used
        ],
        "already_watched": sorted(used),
        "roles": [{"title": r.title, "role_type": r.role_archetype_key} for r in roles],
    }
    out: MeasureAdvice = await _ask(
        "measures",
        goal,
        context,
        MeasureAdvice,
        MeasureAdvice(summary="(local fake model)", suggestions=[]),
    )
    allowed = {t.key for t in templates if t.key not in used}
    titles = {r.title for r in roles}
    ideas = [
        {**m.model_dump(), "roles": [r for r in m.roles if r in titles]}
        for m in out.suggestions[:6]
        if m.template in allowed
    ]
    return {"summary": out.summary, "suggestions": ideas}


async def add_measure(actor: str, tenant_id: uuid.UUID, body: dict[str, Any]) -> dict[str, Any]:
    """Add a measure to a live workspace by hand: a catalog template and the roles that see it."""
    from decimal import Decimal

    from app.models import RoleMetric

    await console._tenant(tenant_id)
    templates, _ = await ob_svc._feedable_templates(tenant_id)
    t = next((x for x in templates if x.key == body.get("template")), None)
    if t is None:
        raise Invalid("pick a measure this workspace's data can feed")
    name = str(body.get("name") or t.key.replace("_", " ").capitalize())[:200]
    roles_in = body.get("roles") or []
    if not roles_in:
        raise Invalid("pick at least one role")
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        assert tenant is not None
        roles = {str(r.id): r for r in await s.scalars(select(RoleNode))}
        existing = await s.scalar(select(Metric).where(Metric.key == t.key))
        if existing is not None and existing.is_active:
            raise Conflict(f"{t.key} is already watched; change it in the table above")
        metric = existing or Metric(tenant_id=tenant_id, key=t.key)
        metric.name, metric.sql_template_key, metric.sql_template_version = name, t.key, t.version
        metric.params = {
            k: v.get("default") for k, v in (t.params_schema or {}).items() if isinstance(v, dict)
        }
        metric.unit = str(body.get("unit") or tenant.currency)[:30]
        metric.higher_is_better = bool(body.get("higher_is_better", False))
        metric.unit_value = Decimal(str(body.get("unit_value", 1)))
        metric.is_active = True
        if existing is None:
            s.add(metric)
        await s.flush()
        for r in roles_in:
            role = roles.get(str(r.get("role_id")))
            if role is None:
                raise Invalid("unknown role")
            th = r.get("threshold")
            s.add(
                RoleMetric(
                    tenant_id=tenant_id,
                    role_node_id=role.id,
                    metric_id=metric.id,
                    weight=console._number(r.get("weight", 1), "weight", 0, 5),
                    threshold=None
                    if th in (None, "")
                    else console._number(th, "threshold", -1e9, 1e9),
                    daily_check=bool(r.get("daily_check", False)),
                )
            )
        key = metric.key
    await console._log(actor, "workspace", f"metric:{key}", None, {"added": name}, tenant_id)
    return {"status": "ok", "metric": key}
