"""Targeted edits to one item of an onboarding proposal (ADR 0029).

A proposal is a list of items: mapping links, org roles, measures, rule changes. The team can
change ONE item, by hand or by asking the AI, and nothing else moves:
- the item is replaced in a new proposal; every other item is copied as it was;
- the item is locked: a later full re-run gets it as fixed and code puts it back after;
- only the item's own checks run again (a mapping link's live test, a measure's check);
- steps never rewrite each other: fixing a mapping link does not touch which measures are
  watched or how, and changing a measure does not touch the mapping.
"""

import json
import re
import uuid
from typing import Any, Literal

from pydantic import BaseModel
from sqlalchemy import select

from app.core.db import tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.logging import get_logger
from app.domain import onboarding as ob
from app.domain.config import SCHEMA, coerce
from app.integrations.llm import get_llm
from app.models import OnboardingStep, RoleNode
from app.repositories import agents as agent_repo
from app.schemas.onboarding import (
    ArchetypeProposal,
    ClientQuestion,
    Coverage,
    DiscoveryOut,
    ParamValue,
    QualityIssue,
    RoleDraft,
)
from app.services import onboarding as svc
from app.services import onboarding_collab
from app.services.agents import _choice

log = get_logger(__name__)
AGENT = "proposal_editor"
INSTRUCTION_MAX = 2000


# ---- what the AI may return for each kind of item -------------------------------------------


class Threshold(BaseModel):
    kind: Literal["none", "fixed", "percentile", "median_multiple"]
    value: float
    basis: str


class Attach(BaseModel):
    role_ref: str
    weight: float
    threshold: Threshold
    daily_check: bool
    why: str


class Measure(BaseModel):
    key: str
    name: str
    template: str
    template_version: int
    unit: str
    higher_is_better: bool
    unit_value: float
    unit_value_basis: str
    params: list[ParamValue]
    attach: list[Attach]


class Setting(BaseModel):
    key: str
    value: float
    reason: str


MODELS: dict[str, type[BaseModel]] = {
    "mapping": ArchetypeProposal,
    "org": RoleDraft,
    "metrics": Measure,
    "rules": Setting,
}


def _find(data: dict[str, Any], step: str, key: str) -> dict[str, Any]:
    field, kf = svc.ITEMS[step]
    for item in data.get(field, []):
        if item.get(kf) == key:
            return dict(item)
    raise NotFound(f"{step} item {key}")


async def _proposal(tenant_id: uuid.UUID, step: str, step_id: uuid.UUID) -> OnboardingStep:
    if step not in svc.ITEMS:
        raise Invalid(f"{step} has no items to edit")
    await onboarding_collab.require_team_can_work(tenant_id, step)
    base = await svc._base(tenant_id, step_id, step)
    if base.status != "proposed":
        raise Conflict("only an open proposal can be edited; run the analysis again first")
    return base


# ---- context the AI gets for one item -------------------------------------------------------


async def _context(
    tenant_id: uuid.UUID, step: str, item: dict[str, Any], base: OnboardingStep
) -> dict[str, Any]:
    if step == "mapping":
        discovery = await svc._latest(tenant_id, "discovery", approved=True)
        profile = (discovery.input or {}).get("profile", {})
        sql = item.get("source_sql", "").upper()
        tables = [
            t
            for t in profile.get("tables", [])
            if str(t.get("table", "")).split(".")[-1].upper() in sql
        ]
        spec = next((a for a in await svc._archetypes() if a["archetype"] == item["archetype"]), {})
        return {
            "archetype_fields": spec,
            "tables_used": tables[:6],
            "database": profile.get("database"),
            "dialect": "snowflake",
        }
    if step == "metrics":
        templates, _ = await svc._feedable_templates(tenant_id)
        async with tenant_tx("service", tenant_id) as s:
            refs = svc._refs(list((await s.scalars(select(RoleNode))).all()))
        return {
            "templates": [
                {
                    "key": t.key,
                    "version": t.version,
                    "description": t.description,
                    "params": t.params_schema,
                }
                for t in templates
            ],
            "roles": [{"ref": r, "title": n.title} for r, n in refs.items()],
            "threshold_kinds": "none = trend only; fixed = value is the alert level in the "
            "measure's unit; percentile = value 50-99 of today's values; "
            "median_multiple = value times today's median",
        }
    if step == "rules":
        key = item["key"]
        rules = await svc._rules(tenant_id)
        meta = SCHEMA[key]
        return {
            "setting": {
                "key": key,
                "label": meta.label,
                "meaning": meta.help,
                "min": meta.minimum,
                "max": meta.maximum,
                "unit": meta.unit,
                "now": getattr(rules, key),
            }
        }
    roles = (base.output or {}).get("roles", [])
    return {
        "role_archetypes": await svc._role_archetypes(),
        "other_roles": [
            {"ref": r["ref"], "title": r["title"]} for r in roles if r["ref"] != item["ref"]
        ],
        "playbooks": list(ob.PLAYBOOKS),
    }


# ---- validate one item and save a new proposal ----------------------------------------------


async def _save(
    actor: str,
    tenant_id: uuid.UUID,
    step: str,
    base: OnboardingStep,
    key: str,
    item: dict[str, Any] | None,
    note: str,
    lock: bool = True,
    confirm: bool = False,
) -> dict[str, Any]:
    field, kf = svc.ITEMS[step]
    data = json.loads(json.dumps(base.output))
    if item is not None:
        item = {**item, kf: key}  # the key never changes: other steps refer to it
        data[field] = [item if i.get(kf) == key else i for i in data[field]]
    locked = set(data.get("locked", []))
    data["locked"] = sorted(locked | {key} if lock else locked - {key})
    # A change or an unlock needs a new look; only "confirm" marks a mapping link as checked.
    confirmed = set(data.get("confirmed", []))
    data["confirmed"] = sorted(confirmed | {key} if confirm else confirmed - {key})
    checks: dict[str, Any]

    if step == "mapping":
        discovery = await svc._latest(tenant_id, "discovery", approved=True)
        checks = await svc.check_mapping(
            svc._warehouse(),
            await svc._connection(tenant_id),
            tenant_id,
            data,
            (discovery.input or {})["profile"],
            await svc._archetypes(),
        )
    elif step == "org":
        report = ob.check_org(data, {a["key"] for a in await svc._role_archetypes()})
        checks = {
            **report.as_dict(),
            "from_client_draft": (base.checks or {}).get("from_client_draft", False),
        }
    elif step == "metrics":
        templates, maps = await svc._feedable_templates(tenant_id)
        async with tenant_tx("service", tenant_id) as s:
            refs = svc._refs(list((await s.scalars(select(RoleNode))).all()))
        infos = {
            t.key: ob.TemplateInfo(t.key, t.version, frozenset(t.aliases.values()), t.params_schema)
            for t in templates
        }
        before = {a["role_ref"]: a for a in _find(base.output or {}, step, key).get("attach", [])}
        warnings: list[str] = []
        for m in data["metrics"]:
            if m["key"] != key:
                continue
            if m["template"] in infos:
                m["template_version"] = infos[m["template"]].version
            for a in m["attach"]:
                rule, prev = a["threshold"], before.get(a["role_ref"], {})
                if rule["kind"] == "none":
                    a["threshold_value"] = None
                elif rule["kind"] == "fixed":
                    a["threshold_value"] = float(rule["value"])
                elif prev.get("threshold") == rule:
                    a["threshold_value"] = prev.get("threshold_value")
                else:
                    a["threshold_value"] = None
                    warnings.append(
                        f"{key} for {a['role_ref']}: a {rule['kind']} level is computed "
                        "by a full analysis; type a fixed level or run it again"
                    )
        report = ob.check_metrics(data, infos, set(maps), set(refs))
        report.warnings.extend(warnings)
        checks = {**report.as_dict(), "dry_runs": (base.checks or {}).get("dry_runs", {})}
    else:  # rules
        current = await svc._rules(tenant_id)
        if key not in SCHEMA or key in ob.BLOCKED_RULE_KEYS:
            raise Invalid(f"{key} cannot be changed during onboarding")
        for c in data["changes"]:
            if c["key"] == key:
                try:
                    c["clean_value"] = coerce(key, c["value"])
                except ValueError as exc:
                    raise Invalid(f"{SCHEMA[key].label}: {exc}") from exc
                c["current"] = getattr(current, key)
        checks = {"ok": True, "errors": [], "warnings": []}

    checks["edited_by"] = actor
    checks["edited_item"] = key
    result = await svc._edited_copy(actor, tenant_id, base, data, checks)
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, uuid.UUID(result["step_id"]))
        assert row is not None
        row.notes = note[:2000]
    return {
        **result,
        "item": key,
        "errors": checks.get("errors", []),
        "warnings": checks.get("warnings", []),
    }


# ---- the three actions -----------------------------------------------------------------------


async def edit_item(
    actor: str, tenant_id: uuid.UUID, step: str, step_id: uuid.UUID, key: str, item: dict[str, Any]
) -> dict[str, Any]:
    """The team typed the item (rename a role, rewrite a link's SQL, set a value)."""
    base = await _proposal(tenant_id, step, step_id)
    _find(base.output or {}, step, key)
    try:
        clean = MODELS[step].model_validate({**item, svc.ITEMS[step][1]: key}).model_dump()
    except ValueError as exc:
        raise Invalid(f"the item does not have the expected shape: {str(exc)[:300]}") from exc
    return await _save(actor, tenant_id, step, base, key, clean, f"{key} edited by hand")


async def confirm_item(
    actor: str, tenant_id: uuid.UUID, step: str, step_id: uuid.UUID, key: str
) -> dict[str, Any]:
    """The team checked a mapping link and keeps it (it is also locked against a re-run)."""
    if step != "mapping":
        raise Invalid("only mapping links are confirmed one by one")
    base = await _proposal(tenant_id, step, step_id)
    _find(base.output or {}, step, key)
    return await _save(
        actor, tenant_id, step, base, key, None, f"{key} confirmed", lock=True, confirm=True
    )


async def unlock_item(
    actor: str, tenant_id: uuid.UUID, step: str, step_id: uuid.UUID, key: str
) -> dict[str, Any]:
    """Let the next full analysis change this item again."""
    base = await _proposal(tenant_id, step, step_id)
    return await _save(actor, tenant_id, step, base, key, None, f"{key} unlocked", lock=False)


async def revise_item(
    actor: str, tenant_id: uuid.UUID, step: str, step_id: uuid.UUID, key: str, instruction: str
) -> dict[str, Any]:
    """Ask the AI to change ONE item as instructed. It sees that item and what it needs to
    change it, never the rest of the proposal, so it cannot change anything else."""
    instruction = instruction.strip()
    if not instruction:
        raise Invalid("say what should change")
    if len(instruction) > INSTRUCTION_MAX:
        raise Invalid(f"keep it under {INSTRUCTION_MAX} characters")
    base = await _proposal(tenant_id, step, step_id)
    item = _find(base.output or {}, step, key)
    context = await _context(tenant_id, step, item, base)
    async with tenant_tx("service", tenant_id) as s:
        found = await agent_repo.active(s, AGENT)
        if found is None:
            raise Conflict(f"agent {AGENT} is not loaded: run make seed")
        agent, prompt = found
        choice = await _choice(s, agent)
    user = json.dumps(
        {"step": step, "item": item, "instruction": instruction, "context": context},
        ensure_ascii=False,
        default=str,
    )
    model = MODELS[step]
    fake = (
        model.model_validate(item)
        if step != "metrics"
        else Measure.model_validate(_as_measure(item))
    )
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body, user, model, fake=fake, effort="low", timeout_s=180
    )
    log.info(
        "onboarding.revise_item",
        step=step,
        item=key,
        model=result.model,
        tokens=result.input_tokens + result.output_tokens,
    )
    if result.parsed is None:
        raise Conflict(f"the AI could not revise it: {result.error or 'no answer'}")
    revised = result.parsed.model_dump()
    said = re.sub(r"\s+", " ", instruction)
    out = await _save(actor, tenant_id, step, base, key, revised, f"{key} revised by AI: {said}")
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, uuid.UUID(out["step_id"]))
        assert row is not None
        row.agent_key, row.agent_version = agent.key, prompt.version
        row.provider, row.model = result.provider, result.model
        row.input_tokens, row.output_tokens = result.input_tokens, result.output_tokens
        row.latency_ms = result.latency_ms
    return out


def _as_measure(item: dict[str, Any]) -> dict[str, Any]:
    """A stored measure in the AI's shape (a typed level is stored as kind "fixed")."""
    return {
        **item,
        "attach": [
            {k: a[k] for k in ("role_ref", "weight", "threshold", "daily_check", "why")}
            for a in item.get("attach", [])
        ],
    }


# ---- discovery sections (ADR 0030) -----------------------------------------------------------
# Discovery is one document. The team reviews it in three sections and can lock one or ask the AI
# to change only that section; the others are copied as they were.

SECTIONS = ("guide", "relationships", "gaps")


class GuideTable(BaseModel):
    table: str
    kind: Literal["fact", "dimension", "lookup", "other"]
    grain: str
    purpose: str
    key_columns: list[str]


class GuideSection(BaseModel):
    summary: str
    cadence: str
    tables: list[GuideTable]


class JoinRow(BaseModel):
    table: str
    column: str
    references_table: str
    references_column: str
    confidence: Literal["high", "medium", "low"]


class RelationshipsSection(BaseModel):
    joins: list[JoinRow]


class GapsSection(BaseModel):
    coverage: list[Coverage]
    quality_issues: list[QualityIssue]
    questions: list[ClientQuestion]


SECTION_MODELS: dict[str, type[BaseModel]] = {
    "guide": GuideSection,
    "relationships": RelationshipsSection,
    "gaps": GapsSection,
}


def section_slice(out: dict[str, Any], section: str) -> dict[str, Any]:
    """The part of a discovery answer that one section owns."""
    if section == "guide":
        return {
            "summary": out["summary"],
            "cadence": out["cadence"],
            "tables": [
                {k: t[k] for k in ("table", "kind", "grain", "purpose", "key_columns")}
                for t in out["tables"]
            ],
        }
    if section == "relationships":
        return {"joins": [{"table": t["table"], **j} for t in out["tables"] for j in t["joins"]]}
    return {k: out[k] for k in ("coverage", "quality_issues", "questions")}


def _short(name: str) -> str:
    return name.split(".")[-1].upper()


def apply_section(
    out: dict[str, Any], section: str, new: dict[str, Any], profile: dict[str, Any]
) -> dict[str, Any]:
    """A copy of the discovery answer with only this section replaced."""
    data: dict[str, Any] = json.loads(json.dumps(out))
    by_table = {t["table"]: t for t in data["tables"]}
    if section == "guide":
        data["summary"], data["cadence"] = new["summary"], new["cadence"]
        for t in new["tables"]:
            if t["table"] in by_table:  # a table the scan did not find cannot be added here
                by_table[t["table"]].update({k: t[k] for k in t if k != "table"})
    elif section == "relationships":
        columns = {
            str(t["table"]).upper(): {str(c["column"]).upper() for c in t.get("columns", [])}
            for t in profile.get("tables", [])
        }
        for t in data["tables"]:
            t["joins"] = []
        for j in new["joins"]:
            ref = next((n for n in by_table if _short(n) == _short(j["references_table"])), None)
            if j["table"] not in by_table or ref is None:
                raise Invalid(
                    f"{j['table']} to {j['references_table']}: both tables must be in the scan"
                )
            for tbl, col in ((j["table"], j["column"]), (ref, j["references_column"])):
                known = columns.get(tbl.upper())
                if known and col.upper() not in known:
                    raise Invalid(f"{tbl} has no column {col}")
            by_table[j["table"]]["joins"].append(
                {
                    "column": j["column"],
                    "references_table": ref,
                    "references_column": j["references_column"],
                    "confidence": j["confidence"],
                }
            )
    else:
        for k in ("coverage", "quality_issues", "questions"):
            data[k] = new[k]
    DiscoveryOut.model_validate({"semantic_views": [], **data})
    return data


async def _discovery_base(tenant_id: uuid.UUID, step_id: uuid.UUID, section: str) -> OnboardingStep:
    if section not in SECTIONS:
        raise NotFound(f"discovery section {section}")
    await onboarding_collab.require_team_can_work(tenant_id, "discovery")
    base = await svc._base(tenant_id, step_id, "discovery")
    if base.status != "proposed":
        raise Conflict("only an open proposal can be edited; run the analysis again first")
    return base


async def _save_section(
    actor: str,
    tenant_id: uuid.UUID,
    base: OnboardingStep,
    section: str,
    data: dict[str, Any],
    note: str,
    lock: bool,
) -> dict[str, Any]:
    locked = set(data.get("locked_sections", []))
    data["locked_sections"] = sorted(locked | {section} if lock else locked - {section})
    checks = {**(base.checks or {}), "edited_by": actor, "edited_section": section}
    result = await svc._edited_copy(actor, tenant_id, base, data, checks)
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, uuid.UUID(result["step_id"]))
        assert row is not None
        row.notes = note[:2000]
    return {**result, "section": section}


async def set_section_lock(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, section: str, lock: bool
) -> dict[str, Any]:
    base = await _discovery_base(tenant_id, step_id, section)
    data = json.loads(json.dumps(base.output))
    word = "locked" if lock else "unlocked"
    return await _save_section(actor, tenant_id, base, section, data, f"{section} {word}", lock)


async def revise_section(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, section: str, instruction: str
) -> dict[str, Any]:
    """Ask the AI to change ONE discovery section. It sees that section and the profile, never
    the other sections, and a locked section is refused."""
    instruction = instruction.strip()
    if not instruction:
        raise Invalid("say what should change")
    if len(instruction) > INSTRUCTION_MAX:
        raise Invalid(f"keep it under {INSTRUCTION_MAX} characters")
    base = await _discovery_base(tenant_id, step_id, section)
    out = base.output or {}
    if section in out.get("locked_sections", []):
        raise Conflict("this section is locked; unlock it to change it")
    profile = (base.input or {}).get("profile", {})
    current = section_slice(out, section)
    async with tenant_tx("service", tenant_id) as s:
        found = await agent_repo.active(s, AGENT)
        if found is None:
            raise Conflict(f"agent {AGENT} is not loaded: run make seed")
        agent, prompt = found
        choice = await _choice(s, agent)
    context = {
        "section": section,
        "tables": [
            {
                "table": t.get("table"),
                "rows": t.get("rows"),
                "columns": [c.get("column") for c in t.get("columns", [])],
            }
            for t in profile.get("tables", [])
        ],
        "rule": "change only what the instruction asks; keep every other entry as given",
    }
    user = json.dumps(
        {"step": "discovery", "item": current, "instruction": instruction, "context": context},
        ensure_ascii=False,
        default=str,
    )
    model = SECTION_MODELS[section]
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body, user, model, fake=model.model_validate(current), effort="low", timeout_s=180
    )
    log.info(
        "onboarding.revise_section",
        section=section,
        model=result.model,
        tokens=result.input_tokens + result.output_tokens,
    )
    if result.parsed is None:
        raise Conflict(f"the AI could not revise it: {result.error or 'no answer'}")
    data = apply_section(out, section, result.parsed.model_dump(), profile)
    said = re.sub(r"\s+", " ", instruction)
    saved = await _save_section(
        actor, tenant_id, base, section, data, f"{section} revised by AI: {said}", lock=False
    )
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, uuid.UUID(saved["step_id"]))
        assert row is not None
        row.agent_key, row.agent_version = agent.key, prompt.version
        row.provider, row.model = result.provider, result.model
        row.input_tokens, row.output_tokens = result.input_tokens, result.output_tokens
        row.latency_ms = result.latency_ms
    return saved
