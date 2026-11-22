"""Metric library and custom metrics for a workspace (onboarding, metrics step).

- `library`: the metrics each data archetype is expected to feed, found / not found against the
  approved mapping (domain.metric_library).
- `add_to_plan` / `remove_from_plan`: put a library or custom metric into the metrics proposal,
  or take it out. The team still approves the plan as before.
- Custom metrics: a calculation for this workspace only. Typed by hand or drafted by the AI from
  the team's instructions, checked by code (placeholders, contract, a real dry run), then
  approved by the team. An approved one is frozen; a change is a new version.
"""

import json
import re
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel
from sqlalchemy import select

from app.core.db import tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.settings import get_settings
from app.domain import metric_library as lib
from app.domain import onboarding as ob
from app.domain import runs as run_rules
from app.domain.templates import TemplateError, check_contract, render
from app.integrations.llm import get_llm
from app.integrations.warehouse import WarehouseClient
from app.models import ArchetypeMapping, CustomTemplate, DataArchetype, RoleNode, SqlTemplate
from app.repositories import agents as agent_repo
from app.services import onboarding as onb
from app.services import onboarding_collab
from app.services.agents import _choice

DRAFT_AGENT = "custom_metric_drafter"
DRY_CAP = 2000
PLAYBOOKS = ("sales", "purchasing", "inventory", "executive")


class ParamDraft(BaseModel):
    name: str
    default: int
    minimum: int
    maximum: int


class CustomDraftOut(BaseModel):
    description: str
    sql: str
    params: list[ParamDraft]
    unit: str
    higher_is_better: bool
    notes: str


def _read_library() -> dict[str, list[dict[str, Any]]]:
    root = Path(get_settings().catalog_dir) / "metric_library"
    out: dict[str, list[dict[str, Any]]] = {}
    for f in sorted(root.glob("*.yaml")):
        doc = yaml.safe_load(f.read_text(encoding="utf-8"))
        out[doc["archetype"]] = list(doc["metrics"])
    return out


async def _facts(tenant_id: uuid.UUID) -> dict[str, Any]:
    """Approved mappings with the measured fill of each field, and the templates in play."""
    try:
        step = await onb._latest(tenant_id, "mapping", approved=True)
        measured = (step.checks or {}).get("archetypes") or {}
    except Conflict:
        measured = {}
    async with tenant_tx("service", tenant_id) as s:
        maps = {m.archetype_key: m for m in await s.scalars(select(ArchetypeMapping))}
        catalog = (await s.scalars(select(SqlTemplate))).all()
        own = (await s.scalars(select(CustomTemplate).order_by(CustomTemplate.created_at))).all()
    mapped: dict[str, dict[str, float] | None] = {}
    for key in maps:
        fills = (measured.get(key) or {}).get("fills")
        mapped[key] = {f["field"]: f["fill_pct"] for f in fills} if fills else None
    latest: dict[str, SqlTemplate] = {}
    for t in catalog:
        if t.key not in latest or t.version > latest[t.key].version:
            latest[t.key] = t
    return {"mapped": mapped, "templates": latest, "custom": list(own), "maps": maps}


async def _plan_keys(tenant_id: uuid.UUID) -> tuple[set[str], set[str]]:
    """Templates now in the metrics proposal, and those the team removed from it."""
    try:
        out = await onb._latest_output(tenant_id, "metrics")
    except Conflict:
        return set(), set()
    return (
        {m["template"] for m in out.get("metrics", [])},
        {s["template"] for s in out.get("skipped", [])},
    )


def _custom_view(t: CustomTemplate) -> dict[str, Any]:
    return {
        "id": str(t.id), "key": t.key, "version": t.version, "name": t.name,
        "playbook": t.playbook, "description": t.description, "instructions": t.instructions,
        "archetypes": sorted(set(t.aliases.values())), "origin": t.origin, "status": t.status,
        "sql": t.sql, "params": t.params_schema, "dry_run": t.dry_run,
        "created_by": t.created_by, "approved_by": t.approved_by,
        "approved_at": t.approved_at.isoformat() if t.approved_at else None,
    }  # fmt: skip


async def library(tenant_id: uuid.UUID) -> dict[str, Any]:
    facts = await _facts(tenant_id)
    in_plan, removed = await _plan_keys(tenant_id)
    groups = []
    all_rows: list[dict[str, Any]] = []
    for archetype, entries in _read_library().items():
        rows = []
        for e in entries:
            t = facts["templates"].get(e["template"]) if e.get("template") else None
            row = lib.judge(e, archetype, set(t.aliases.values()) if t else None, facts["mapped"])
            row["message"] = lib.explain(row)
            row["unit"], row["higher_is_better"] = e.get("unit", ""), e.get("higher_is_better")
            row["state"] = (
                "in_plan" if row["template"] in in_plan
                else "removed" if row["template"] in removed else "available"
            )  # fmt: skip
            rows.append(row)
        all_rows += rows
        groups.append(
            {"archetype": archetype, "mapped": archetype in facts["mapped"],
             "summary": lib.summarize(rows), "metrics": rows}
        )  # fmt: skip
    customs = []
    for c in facts["custom"]:
        v = _custom_view(c)
        v["state"] = "in_plan" if c.key in in_plan else "available"
        customs.append(v)
    return {"summary": lib.summarize(all_rows), "archetypes": groups, "custom": customs}


# ---------------------------------------------------------------------------------------------
# Put a metric into the plan, or take it out
# ---------------------------------------------------------------------------------------------


async def _template(tenant_id: uuid.UUID, key: str) -> Any:
    """The newest catalog template for this key, or this workspace's approved custom one."""
    templates, _ = await onb._feedable_templates(tenant_id)
    best = None
    for t in templates:
        if t.key == key and (best is None or t.version > best.version):
            best = t
    return best


async def _measure(
    tenant_id: uuid.UUID, tpl: Any, wh: WarehouseClient
) -> tuple[dict[str, Any], list[float]]:
    """A dry run of a template for the plan: its shape and each entity's latest value."""
    conn = await onb._connection(tenant_id)
    rules = await onb._rules(tenant_id)
    _, maps = await onb._feedable_templates(tenant_id)
    params = {
        **{k: v.get("default") for k, v in tpl.params_schema.items()},
        "period_end": run_rules.period_end(datetime.now(UTC), "weekly"),
        "row_cap": onb.PROFILE_CAP,
    }
    try:
        sql = render(tpl.sql, tpl.aliases, maps)
        check_contract(sql)
        result = await wh.query(
            conn, sql, params, f"formada:onboarding:dry:{tpl.key}",
            rules.query_timeout_seconds, onb.PROFILE_CAP,
        )  # fmt: skip
    except Exception as exc:
        return {"error": str(exc)[:300]}, []
    shape = ob.dry_run_shape(result.rows, result.truncated, onb.PROFILE_CAP)
    shape["rows_needed_vs_workspace_cap"] = {
        "rows": len(result.rows), "row_cap": rules.query_row_cap,
        "fits": len(result.rows) <= rules.query_row_cap,
    }  # fmt: skip
    last: dict[str, float] = {}
    for r in result.rows:
        last[str(r["entity"])] = float(r["value"] or 0)
    return shape, list(last.values())


async def add_to_plan(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, body: dict[str, Any],
    warehouse: WarehouseClient | None = None,
) -> dict[str, Any]:  # fmt: skip
    """Add one library or approved custom metric to the metrics proposal, owned by named roles."""
    await onboarding_collab.require_team_can_work(tenant_id, "metrics")
    base = await onb._base(tenant_id, step_id, "metrics")
    key = body["template"]
    tpl = await _template(tenant_id, key)
    if tpl is None:
        raise Invalid(
            f"{key} cannot run on the approved mappings (not built, not approved, or data missing)"
        )
    roles = body.get("roles") or []
    async with tenant_tx("service", tenant_id) as s:
        refs = onb._refs(list((await s.scalars(select(RoleNode))).all()))
    unknown = [r for r in roles if r not in refs]
    if not roles or unknown:
        raise Invalid(f"choose who owns it: {unknown or 'at least one role'}")
    data = json.loads(json.dumps(base.output))
    if any(m["template"] == key for m in data["metrics"]):
        raise Conflict(f"{key} is already in the plan")
    entry = next((e for es in _read_library().values() for e in es if e.get("template") == key), {})
    metric_key = re.sub(r"[^a-z0-9_]+", "_", key.lower())[:60]
    taken = {m["key"] for m in data["metrics"]}
    while metric_key in taken:
        metric_key += "_2"
    data["metrics"].append({
        "key": metric_key,
        "name": str(body.get("name") or entry.get("name", {}).get("en") or key)[:200],
        "template": key, "template_version": tpl.version,
        "unit": str(body.get("unit") or entry.get("unit") or getattr(tpl, "unit", "") or "")[:30],
        "higher_is_better": bool(
            body.get("higher_is_better", entry.get("higher_is_better", True))
        ),
        "unit_value": float(body.get("unit_value") or 1.0),
        "unit_value_basis": "default set when added by our team: set the money value per unit",
        "params": [],
        "attach": [
            {"role_ref": r, "weight": 1.0, "daily_check": False,
             "why": "added by our team",
             "threshold": {"kind": "median_multiple", "value": 2.0, "basis": "default"}}
            for r in roles
        ],
    })  # fmt: skip
    data["skipped"] = [s for s in data.get("skipped", []) if s["template"] != key]
    data["locked"] = sorted(set(data.get("locked", [])) | {metric_key})
    # Alert levels come from a real run on the customer's data, as for the advisor's metrics.
    shape, latest = await _measure(tenant_id, tpl, warehouse or onb._warehouse())
    added = data["metrics"][-1]
    for a in added["attach"]:
        rule = a["threshold"]
        a["threshold_value"] = ob.threshold_from_rule(rule["kind"], rule["value"], latest)
        a["would_fire"] = ob.would_fire(a["threshold_value"], added["higher_is_better"], latest)
    return await _checked_copy(actor, tenant_id, base, data, {key: shape})


async def _checked_copy(
    actor: str, tenant_id: uuid.UUID, base: Any, data: dict[str, Any],
    new_dry_runs: dict[str, Any] | None = None,
) -> dict[str, Any]:  # fmt: skip
    templates, maps = await onb._feedable_templates(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        refs = onb._refs(list((await s.scalars(select(RoleNode))).all()))
    infos = {
        t.key: ob.TemplateInfo(t.key, t.version, frozenset(t.aliases.values()), t.params_schema)
        for t in templates
    }
    report = ob.check_metrics(data, infos, set(maps), set(refs))
    # Alert levels for a metric added by hand come from a dry run of its own template.
    dry_runs = {**(base.checks or {}).get("dry_runs", {}), **(new_dry_runs or {})}
    checks = {**report.as_dict(), "dry_runs": dry_runs, "edited_by": actor}
    return await onb._edited_copy(actor, tenant_id, base, data, checks)


async def remove_from_plan(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, metric_key: str
) -> dict[str, Any]:
    await onboarding_collab.require_team_can_work(tenant_id, "metrics")
    base = await onb._base(tenant_id, step_id, "metrics")
    data = json.loads(json.dumps(base.output))
    gone = [m for m in data["metrics"] if m["key"] == metric_key]
    if not gone:
        raise NotFound("metric")
    data["metrics"] = [m for m in data["metrics"] if m["key"] != metric_key]
    data["skipped"] = [
        *data.get("skipped", []),
        {"template": gone[0]["template"], "reason": "removed by our team"},
    ]
    data["locked"] = [k for k in data.get("locked", []) if k != metric_key]
    return await _checked_copy(actor, tenant_id, base, data)


# ---------------------------------------------------------------------------------------------
# Custom metrics
# ---------------------------------------------------------------------------------------------

_PLACEHOLDER = re.compile(r"\{\{\s*(\w+)(?:\.(\w+))?\s*\}\}")


def check_custom_sql(sql: str, aliases: dict[str, str], columns: dict[str, set[str]]) -> list[str]:
    """Plain-words problems with a custom calculation, before it touches the warehouse."""
    problems: list[str] = []
    for m in _PLACEHOLDER.finditer(sql):
        alias, col = m.group(1), m.group(2)
        if alias not in aliases:
            problems.append(f"unknown alias {alias}")
        elif col is not None and col not in columns.get(aliases[alias], set()):
            problems.append(f"{aliases[alias]} has no field {col}")
    for needed in ("%(period_end)s", "%(row_cap)s"):
        if needed not in sql:
            problems.append(f"it must use {needed}")
    if re.search(r"\b(insert|update|delete|drop|alter|create|merge|truncate|grant)\b", sql, re.I):
        problems.append("only a SELECT is allowed")
    return problems


async def _columns() -> dict[str, set[str]]:
    from app.core.db import global_tx

    async with global_tx("service") as s:
        rows = (await s.scalars(select(DataArchetype))).all()
    return {a.key: set(a.columns) for a in rows}


async def _dry_run(
    tenant_id: uuid.UUID, tpl: dict[str, Any], wh: WarehouseClient
) -> dict[str, Any]:
    """Run the calculation once on the customer's data; the team sees the shape, not the amounts."""
    conn = await onb._connection(tenant_id)
    rules = await onb._rules(tenant_id)
    _, maps = await onb._feedable_templates(tenant_id)
    try:
        sql = render(tpl["sql"], tpl["aliases"], maps)
        check_contract(sql)
    except TemplateError as exc:
        return {"ok": False, "error": str(exc)}
    params = {
        **{k: v.get("default") for k, v in tpl["params_schema"].items()},
        "period_end": run_rules.period_end(datetime.now(UTC), "weekly"),
        "row_cap": DRY_CAP,
    }
    try:
        result = await wh.query(
            conn, sql, params, "formada:onboarding:custom", rules.query_timeout_seconds, DRY_CAP
        )
    except Exception as exc:  # the warehouse's own message tells the team what to fix
        return {"ok": False, "error": str(exc)[:400]}
    need = {"entity", "period_start", "value"}
    if result.rows and not need <= set(result.rows[0]):
        return {"ok": False, "error": f"the result needs the columns {sorted(need)}"}
    if not result.rows:
        return {"ok": False, "error": "it returned no rows on this data"}
    return {"ok": True, **ob.dry_run_shape(result.rows, result.truncated, DRY_CAP)}


async def draft_custom(
    actor: str, tenant_id: uuid.UUID, body: dict[str, Any], warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    """Create a draft custom metric from the team's SQL, or ask the AI to write it."""
    await onboarding_collab.require_team_can_work(tenant_id, "metrics")
    name = body["name"].strip()
    if not name:
        raise Invalid("give the metric a name")
    archetypes = body.get("archetypes") or []
    facts = await _facts(tenant_id)
    bad = [a for a in archetypes if a not in facts["mapped"]]
    if not archetypes or bad:
        raise Invalid(f"choose mapped data to read from; not mapped: {bad or 'none chosen'}")
    columns = await _columns()
    aliases = {f"a{i + 1}" if len(archetypes) > 1 else "t": a for i, a in enumerate(archetypes)}
    instructions = (body.get("instructions") or "").strip()
    wh = warehouse or onb._warehouse()

    if body.get("sql"):
        origin, sql = "hand", body["sql"].strip()
        params = {
            p["name"]: {"type": "integer", "default": p["default"],
                        "minimum": p["minimum"], "maximum": p["maximum"]}
            for p in body.get("params", [])
        }  # fmt: skip
        description = body.get("description") or name
        unit, hib = body.get("unit", ""), bool(body.get("higher_is_better", True))
    else:
        if not instructions:
            raise Invalid("write what the metric should show, or paste the calculation")
        origin = "ai"
        out = await _ask_drafter(tenant_id, name, instructions, aliases, columns)
        sql, description = out.sql.strip(), out.description
        params = {
            p.name: {"type": "integer", "default": p.default, "minimum": p.minimum,
                     "maximum": p.maximum}
            for p in out.params
        }  # fmt: skip
        unit, hib = out.unit, out.higher_is_better

    problems = check_custom_sql(sql, aliases, columns)
    taken = {t.key for t in facts["templates"].values()} | {c.key for c in facts["custom"]}
    existing = [c for c in facts["custom"] if c.key == body.get("key")]
    key = body.get("key") or lib.custom_key(name, taken)
    version = max((c.version for c in existing), default=0) + 1
    tpl = {"sql": sql, "aliases": aliases, "params_schema": params}
    dry = (
        {"ok": False, "error": "; ".join(problems)}
        if problems
        else await _dry_run(tenant_id, tpl, wh)
    )
    playbook = body.get("playbook") if body.get("playbook") in PLAYBOOKS else "sales"
    async with tenant_tx("service", tenant_id) as s:
        row = CustomTemplate(
            tenant_id=tenant_id, key=key, version=version, name=name[:200], playbook=playbook,
            description=" ".join(description.split()), instructions=instructions,
            aliases=aliases, sql=sql, drivers={}, params_schema=params, origin=origin,
            status="draft", dry_run={**dry, "unit": unit, "higher_is_better": hib},
            created_by=actor,
        )  # fmt: skip
        s.add(row)
        await s.flush()
        view = _custom_view(row)
    return view


async def _ask_drafter(
    tenant_id: uuid.UUID,
    name: str,
    instructions: str,
    aliases: dict[str, str],
    columns: dict[str, set[str]],
) -> CustomDraftOut:
    payload = {
        "metric_name": name,
        "what_the_team_wants": instructions,
        "tables": [
            {"alias": a, "archetype": arch, "fields": sorted(columns.get(arch, set()))}
            for a, arch in aliases.items()
        ],
    }
    async with tenant_tx("service", tenant_id) as s:
        found = await agent_repo.active(s, DRAFT_AGENT)
        if found is None:
            raise Conflict(f"agent {DRAFT_AGENT} is not loaded: run make seed")
        agent, prompt = found
        choice = await _choice(s, agent)
    fake = CustomDraftOut(
        description=name,
        notes="fake",
        sql=(
            "select {{t.location_name}} as entity, date_trunc('week', {{t.sale_date}})::date as "
            "period_start, sum({{t.net_sales}}) as value, count(*) as n from ({{t}}) as t "
            "where {{t.sale_date}} <= %(period_end)s::date group by 1, 2 order by 1, 2 "
            "limit %(row_cap)s"
        ),
        params=[],
        unit="",
        higher_is_better=True,
    )
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body,
        json.dumps(payload, ensure_ascii=False),
        CustomDraftOut,
        fake=fake,
        effort="medium",
        timeout_s=onb.AGENT_TIMEOUT_S,
    )
    if result.parsed is None:
        raise Conflict(ob.ai_error(result.error or "no answer", "try again"))
    assert isinstance(result.parsed, CustomDraftOut)
    return result.parsed


async def approve_custom(actor: str, tenant_id: uuid.UUID, custom_id: uuid.UUID) -> dict[str, Any]:
    """The team approves a draft whose dry run passed. From now on it is frozen."""
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(CustomTemplate, custom_id)
        if row is None:
            raise NotFound("custom metric")
        if row.status != "draft":
            raise Conflict("only a draft can be approved")
        if not (row.dry_run or {}).get("ok"):
            raise Conflict("the dry run did not pass: fix the calculation first")
        row.status, row.approved_by, row.approved_at = "approved", actor, datetime.now(UTC)
        return _custom_view(row)


async def edit_draft(
    actor: str,
    tenant_id: uuid.UUID,
    custom_id: uuid.UUID,
    body: dict[str, Any],
    warehouse: WarehouseClient | None = None,
) -> dict[str, Any]:
    """Change a draft's calculation. An approved one is frozen: add a new version instead."""
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(CustomTemplate, custom_id)
        if row is None:
            raise NotFound("custom metric")
        if row.status != "draft":
            raise Conflict("an approved metric is frozen: create a new version to change it")
    view = await draft_custom(
        actor, tenant_id,
        {"name": body.get("name", row.name), "key": row.key, "sql": body.get("sql", row.sql),
         "archetypes": sorted(set(row.aliases.values())), "playbook": row.playbook,
         "instructions": row.instructions, "unit": (row.dry_run or {}).get("unit", ""),
         "higher_is_better": (row.dry_run or {}).get("higher_is_better", True),
         "params": [{"name": k, **{f: v[f] for f in ("default", "minimum", "maximum")}}
                    for k, v in row.params_schema.items()]},
        warehouse,
    )  # fmt: skip
    async with tenant_tx("service", tenant_id) as s:  # the edited copy replaces the old draft
        old = await s.get(CustomTemplate, custom_id)
        if old is not None and old.status == "draft":
            old.status = "retired"
    return view


async def retire_custom(actor: str, tenant_id: uuid.UUID, custom_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(CustomTemplate, custom_id)
        if row is None:
            raise NotFound("custom metric")
        if row.status == "approved":
            raise Conflict("it is in use once approved: remove it from the plan instead")
        row.status = "retired"
        return _custom_view(row)
