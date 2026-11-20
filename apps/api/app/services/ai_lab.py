"""AI lab (dev mode): see what every onboarding agent was given, how it was told to think, what it
answered and what code made of it, then try an edited prompt, model or input on the same case.

Nothing here writes a proposal: a test runs the agent exactly as the step does (same input, same
schema, same code checks) and hands back the result for comparison. Saving a prompt as a new
version and activating it are the existing agent routes.
"""

import json
import uuid
from typing import Any

from pydantic import BaseModel
from sqlalchemy import select

from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.domain import guide_audit
from app.domain import onboarding as ob
from app.domain.llm import estimated_cost, validate_choice
from app.integrations.llm import get_llm
from app.models import Agent, AgentPrompt, OnboardingStep, Tenant
from app.repositories import agents as agent_repo
from app.schemas.onboarding import DiscoveryOut, MappingOut, MetricsOut, OrgOut, RulesOut
from app.services import onboarding as svc
from app.services.agents import _choice

STEPS = ("discovery", "mapping", "org", "metrics", "rules")
SCHEMAS: dict[str, type[BaseModel]] = {
    "discovery": DiscoveryOut,
    "mapping": MappingOut,
    "org": OrgOut,
    "metrics": MetricsOut,
    "rules": RulesOut,
}
EFFORTS = ("low", "medium", "high")

TITLES = {
    "discovery": "1. Discovery: write the data guide",
    "mapping": "2. Mapping: one SELECT per data shape",
    "org": "3. Org web: departments and roles",
    "metrics": "4. Metrics: what each role is measured on",
    "rules": "5. Rules: settings for this workspace",
}
JOBS = {
    "discovery": "Code profiles the warehouse (names, types, counts, fill, dates, tested joins, "
    "semantic views). The agent turns that profile into the data guide.",
    "mapping": "The agent writes one read-only SELECT per standard data shape. Code runs each on "
    "the warehouse and judges rows, fill, values and repeated grain.",
    "org": "The agent proposes departments and roles from the data and the client's draft chart.",
    "metrics": "The agent picks measures from the metric catalog, sets thresholds and owners.",
    "rules": "The agent suggests workspace settings; code keeps only known, allowed ones.",
}


def _criteria(step: str, rules: Any) -> list[dict[str, str]]:
    """What code checks after the agent answers (and the numbers it uses)."""
    code, limit = "Code check", "Number code uses"
    out: dict[str, list[dict[str, str]]] = {
        "discovery": [
            {
                "kind": limit,
                "name": "Join tests",
                "text": f"{rules.discovery_join_probe_budget} "
                "candidate joins are tested on the data, one query each.",
            },
            {
                "kind": limit,
                "name": "Join confirmed at",
                "text": f"{rules.discovery_join_min_overlap_pct:g}% "
                "of a column's values must exist on the key side.",
            },
            {
                "kind": code,
                "name": "Names exist",
                "text": "Every table, key column and join target "
                "the guide names must exist in the profile.",
            },
            {
                "kind": code,
                "name": "Joins match the test",
                "text": "A join the data did not support, "
                "or one claimed high without a test, is flagged.",
            },
            {
                "kind": code,
                "name": "Semantic views",
                "text": "Every view, metric and dimension the "
                "guide names must exist in the profile; families must be known.",
            },
            {
                "kind": code,
                "name": "Complete",
                "text": "Every data family needs a verdict and every profiled table a description.",
            },
        ],
        "mapping": [
            {
                "kind": limit,
                "name": "Repeated rows allowed",
                "text": f"{rules.mapping_grain_tolerance_pct:g}% "
                "of rows may repeat the grain before the mapping is refused.",
            },
            {
                "kind": limit,
                "name": "Query time limit",
                "text": f"{rules.query_timeout_seconds} seconds.",
            },
            {
                "kind": code,
                "name": "One read-only SELECT",
                "text": "No write words, no second statement; "
                "only tables of this database, or semantic views it holds.",
            },
            {
                "kind": code,
                "name": "Names exist",
                "text": "Every table, and every dimension and metric "
                "of a semantic view, must exist.",
            },
            {
                "kind": code,
                "name": "Run on the warehouse",
                "text": "Rows, fill per field, values of "
                "enum fields, negative quantities and repeated grain are measured.",
            },
            {
                "kind": code,
                "name": "Filter values",
                "text": "A literal in a WHERE must be a value the profile saw.",
            },
        ],
        "org": [
            {
                "kind": code,
                "name": "One CEO root",
                "text": "Exactly one root role, using the ceo "
                "archetype; parents come before children.",
            },
            {
                "kind": code,
                "name": "Known names",
                "text": "Archetypes, departments and playbooks must exist; refs are snake_case.",
            },
            {
                "kind": code,
                "name": "Size",
                "text": "3 to 12 roles is usual; outside that is a warning.",
            },
        ],
        "metrics": [
            {
                "kind": code,
                "name": "Template exists",
                "text": "Each metric uses a catalog (or approved "
                "custom) template, its latest version.",
            },
            {
                "kind": code,
                "name": "Data is mapped",
                "text": "Every data shape the template reads is mapped.",
            },
            {
                "kind": code,
                "name": "Bounds",
                "text": "Parameters, unit value, weight (0.1 to 3), "
                "percentile (50 to 99) and median multiple (1 to 10) stay in range.",
            },
            {"kind": code, "name": "Owner", "text": "Every metric is attached to a known role."},
        ],
        "rules": [
            {
                "kind": code,
                "name": "Known settings",
                "text": "Only settings in the business-rule schema, "
                "never access settings; values are coerced to their bounds.",
            },
            {
                "kind": code,
                "name": "Small",
                "text": "More than 6 changes is flagged for a closer look.",
            },
        ],
    }
    return out[step]


async def overview(tenant_id: uuid.UUID | None) -> dict[str, Any]:
    """Every step with its agent, versions and criteria; numbers come from the workspace rules."""
    rules = await svc._rules(tenant_id) if tenant_id else None
    if rules is None:
        from app.domain.config import RulesConfig

        rules = RulesConfig()
    async with global_tx("service") as s:
        agents = {a.key: a for a in await s.scalars(select(Agent))}
        versions = (await s.scalars(select(AgentPrompt).order_by(AgentPrompt.version))).all()
    out = []
    for step in STEPS:
        a = agents.get(svc.AGENTS[step])
        out.append(
            {
                "step": step,
                "title": TITLES[step],
                "job": JOBS[step],
                "agent": a.key if a else svc.AGENTS[step],
                "agent_name": a.name if a else svc.AGENTS[step],
                "active_version": a.active_version if a else None,
                "model_override": a.model_override if a else None,
                "versions": [
                    {
                        "version": v.version,
                        "notes": v.notes,
                        "created_by": v.created_by,
                        "chars": len(v.body),
                        "active": bool(a and v.version == a.active_version),
                    }
                    for v in versions
                    if a and v.agent_key == a.key
                ],
                "criteria": _criteria(step, rules),
                "output_schema": SCHEMAS[step].model_json_schema(),
            }
        )
    return {"steps": out, "efforts": list(EFFORTS)}


def _run_view(row: OnboardingStep, prompt: AgentPrompt | None) -> dict[str, Any]:
    trace = row.trace or {}
    return {
        "id": str(row.id),
        "status": row.status,
        "created_at": row.created_at.isoformat(),
        "created_by": row.created_by,
        "agent": row.agent_key,
        "agent_version": row.agent_version,
        "model": f"{row.provider}/{row.model}" if row.model else None,
        "effort": trace.get("effort"),
        "tokens": {"input": row.input_tokens, "output": row.output_tokens},
        "cost_usd": estimated_cost(row.model or "", row.input_tokens + row.output_tokens),
        "latency_ms": row.latency_ms,
        "error": row.error,
        "thinking": trace.get("thinking") or "",
        "notes": row.notes,
        "system_prompt": prompt.body if prompt else None,
        "input": row.input,
        "output": row.output,
        "checks": row.checks,
    }


async def runs(tenant_id: uuid.UUID, step: str) -> dict[str, Any]:
    """The last runs of one step, newest first; the newest carries the full input and prompt."""
    if step not in STEPS:
        raise NotFound("step")
    async with tenant_tx("service", tenant_id) as s:
        if await s.get(Tenant, tenant_id) is None:
            raise NotFound("workspace")
        rows = (
            await s.scalars(
                select(OnboardingStep)
                .where(OnboardingStep.step == step, OnboardingStep.agent_key.is_not(None))
                .order_by(OnboardingStep.created_at.desc())
                .limit(8)
            )
        ).all()
    async with global_tx("service") as s:
        prompts = {
            (p.agent_key, p.version): p for p in (await s.scalars(select(AgentPrompt))).all()
        }
    return {
        "step": step,
        "runs": [
            _run_view(r, prompts.get((r.agent_key or "", r.agent_version or 0))) for r in rows
        ],
    }


async def _checks(
    tenant_id: uuid.UUID, step: str, data: dict[str, Any], payload: dict[str, Any]
) -> dict[str, Any]:
    """The same code checks the step applies to a fresh answer."""
    if step == "discovery":
        return ob.check_discovery(data, payload["profile"]).as_dict()
    if step == "mapping":
        conn = await svc._connection(tenant_id)
        archetypes = await svc._archetypes()
        return await svc.check_mapping(
            svc._warehouse(), conn, tenant_id, data, payload["profile"], archetypes
        )
    if step == "org":
        known = {a["key"] for a in await svc._role_archetypes()}
        return ob.check_org(data, known).as_dict()
    if step == "rules":
        report, _clean = ob.check_rules(data)
        return report.as_dict()
    return {
        "ok": True,
        "errors": [],
        "warnings": [
            "metrics are checked against the live catalog "
            "when the step runs; the lab shows the schema-checked answer only"
        ],
    }


def _shape(data: dict[str, Any] | None) -> dict[str, int]:
    """How many items each list in an answer holds: a quick way to compare two answers."""
    return {k: len(v) for k, v in (data or {}).items() if isinstance(v, list)}


async def test(actor: str, tenant_id: uuid.UUID, step: str, body: dict[str, Any]) -> dict[str, Any]:
    """Run one step's agent on the case of its latest run, with the changes the body asks for.

    body: version (a saved prompt version) or prompt (draft text, not saved), notes (extra team
    notes), input (replace the whole input), model ("provider/model"), effort.
    """
    if step not in STEPS:
        raise NotFound("step")
    key = svc.AGENTS[step]
    async with tenant_tx("service", tenant_id) as s:
        base = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == step, OnboardingStep.agent_key.is_not(None))
            .order_by(OnboardingStep.created_at.desc())
            .limit(1)
        )
        found = await agent_repo.active(s, key)
        if found is None:
            raise Conflict(f"agent {key} is not loaded")
        agent, active = found
        choice = await _choice(s, agent)
    if base is None and not body.get("input"):
        raise Conflict(f"run the {step} step once first: the lab replays its input")
    payload: dict[str, Any] = dict(body.get("input") or (base.input if base else {}) or {})
    if note := (body.get("notes") or "").strip():
        existing = payload.get("team_notes")
        payload["team_notes"] = (
            [*existing, note]
            if isinstance(existing, list)
            else (f"{existing}\n{note}" if existing else note)
        )

    prompt_text = (body.get("prompt") or "").strip()
    prompt_label = "draft"
    if not prompt_text:
        version = int(body.get("version") or active.version)
        async with global_tx("service") as s:
            row = await s.get(AgentPrompt, (key, version))
        if row is None:
            raise Invalid(f"{key} has no version {version}")
        prompt_text, prompt_label = row.body, f"v{version}"
    if len(prompt_text) < 40:
        raise Invalid("a prompt needs real instructions (at least 40 characters)")

    provider, model = choice.provider, choice.model
    if override := (body.get("model") or "").strip():
        p, _, m = override.partition("/")
        if error := validate_choice(p, m):
            raise Invalid(error)
        provider, model = p, m
    effort = body.get("effort") or "medium"
    if effort not in EFFORTS:
        raise Invalid("effort must be low, medium or high")

    user = json.dumps(payload, ensure_ascii=False, default=str)
    result = await get_llm(provider, model).structured(
        prompt_text, user, SCHEMAS[step], fake=None, effort=effort, timeout_s=svc.AGENT_TIMEOUT_S
    )
    data = result.parsed.model_dump() if result.parsed else None
    checks = await _checks(tenant_id, step, data, payload) if data else None
    return {
        "step": step,
        "prompt": prompt_label,
        "model": f"{result.provider}/{result.model}",
        "effort": effort,
        "tokens": {"input": result.input_tokens, "output": result.output_tokens},
        "cost_usd": estimated_cost(result.model, result.input_tokens + result.output_tokens),
        "latency_ms": result.latency_ms,
        "error": result.error,
        "thinking": result.thinking,
        "raw": None if data else result.raw[:20000],
        "output": data,
        "checks": checks,
        "audit": guide_audit.audit(data, payload["profile"])
        if data and step == "discovery"
        else None,
        "shape": _shape(data),
        "baseline_shape": _shape(base.output if base else None),
        "by": actor,
    }
