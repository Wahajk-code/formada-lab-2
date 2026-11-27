"""AI onboarding (ADR 0026): create a workspace, connect its warehouse, then five agent steps
(discovery, mapping, org, metrics, rules). Each step: code builds a shape-only input, an agent
proposes, code checks the proposal (against the warehouse where it can), the internal team
approves, and approving writes the real tables. Agent steps run in the background because a
model can think for minutes; the console polls the step's status.
"""

import asyncio
import json
import re
import uuid
from collections.abc import Awaitable, Callable, Sequence
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from pydantic import BaseModel
from sqlalchemy import delete, func, select, update

from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.logging import get_logger
from app.core.settings import get_settings
from app.domain import discovery_benchmark as benchmark
from app.domain import discovery_cards as dc
from app.domain import mapping_benchmark, org_import, plan_benchmark, semantic
from app.domain import onboarding as ob
from app.domain import onboarding_flow as flow
from app.domain import runs as run_rules
from app.domain.config import SCHEMA, coerce
from app.domain.llm import estimated_cost, validate_choice
from app.domain.templates import check_contract, render
from app.integrations.llm import get_llm
from app.integrations.replay import LabReplayWarehouse
from app.integrations.snowflake import SnowflakeWarehouse
from app.integrations.warehouse import ConnectionConfig, WarehouseClient
from app.models import (
    Agent,
    ArchetypeMapping,
    ConfigChange,
    CustomTemplate,
    DataArchetype,
    Department,
    LlmSetting,
    LoginIdentity,
    Metric,
    OnboardingStep,
    Person,
    RoleArchetype,
    RoleAssignment,
    RoleMetric,
    RoleNode,
    RulesConfig,
    SqlTemplate,
    Tenant,
    WarehouseConnection,
)
from app.repositories import agents as agent_repo
from app.repositories import org as org_repo
from app.repositories import pipeline as repo
from app.schemas.onboarding import DiscoveryOut, MappingOut, MetricsOut, OrgOut, RulesOut
from app.services import auth as auth_service
from app.services import console, onboarding_collab, onboarding_review
from app.services.agents import _choice
from app.services.metric_shapes import template_shapes

log = get_logger(__name__)
AGENT_TIMEOUT_S = 600
PROFILE_CAP = 5000
STALE_RUNNING = timedelta(minutes=12)
_running: dict[uuid.UUID, asyncio.Task[Any]] = {}  # live background steps, by step id
ORPHAN_GRACE = timedelta(seconds=90)

# Each step's proposal is a list of items; the team can edit or lock one item at a time.
# step -> (list field in the output, key field of an item)
ITEMS: dict[str, tuple[str, str]] = {
    "mapping": ("archetypes", "archetype"),
    "org": ("roles", "ref"),
    "metrics": ("metrics", "key"),
    "rules": ("changes", "key"),
}

AGENTS = {
    "discovery": "discovery_analyst",
    "mapping": "data_mapper",
    "org": "org_designer",
    "metrics": "metric_advisor",
    "rules": "rules_advisor",
}


def lab() -> bool:
    """The hosted review lab: saved snapshots instead of a live warehouse."""
    return get_settings().lab_mode


def _warehouse() -> WarehouseClient:
    return LabReplayWarehouse() if lab() else SnowflakeWarehouse()


def _norm_sql(sql: str) -> str:
    return " ".join(sql.lower().split())


async def _lab_prior(tenant_id: uuid.UUID, step: str) -> list[OnboardingStep]:
    """Saved proposals of a step, newest first (the lab replays what they measured)."""
    async with tenant_tx("service", tenant_id) as s:
        return list(
            (
                await s.scalars(
                    select(OnboardingStep)
                    .where(OnboardingStep.step == step, OnboardingStep.output.is_not(None))
                    .order_by(OnboardingStep.created_at.desc())
                    .limit(12)
                )
            ).all()
        )


# ---------------------------------------------------------------------------------------------
# Workspace and connection
# ---------------------------------------------------------------------------------------------


async def create_workspace(actor: str, body: dict[str, Any]) -> dict[str, Any]:
    email = body["owner_email"].strip().lower()
    if not re.match(r"^[^@\s]+@[^@\s]+\.[^@\s]+$", email):
        raise Invalid("owner email is not valid")
    provider, model = body.get("llm_provider") or "anthropic", body.get("llm_model") or ""
    if error := validate_choice(provider, model):
        raise Invalid(error)
    async with global_tx("service") as s:
        if await s.scalar(select(LoginIdentity).where(LoginIdentity.email == email)):
            raise Conflict(f"{email} already belongs to a workspace")
    tenant_id = uuid.uuid4()
    person_id = uuid.uuid4()
    async with tenant_tx("service", tenant_id) as s:
        s.add(
            Tenant(
                id=tenant_id,
                name=body["name"].strip(),
                locale=body.get("locale", "en"),
                timezone=body.get("timezone", "America/Toronto"),
                currency=body.get("currency", "CAD"),
                lifecycle="onboarding",
            )
        )
        await s.flush()
        s.add(
            Person(
                id=person_id,
                tenant_id=tenant_id,
                email=email,
                name=body["owner_name"].strip(),
                app_role="owner",
                locale=body.get("locale", "en"),
            )
        )
        s.add(
            LlmSetting(
                tenant_id=tenant_id, provider=provider, model=model, updated_at=datetime.now(UTC)
            )
        )
    async with global_tx("service") as s:
        s.add(LoginIdentity(email=email, tenant_id=tenant_id, person_id=person_id))
        s.add(
            ConfigChange(
                workspace_id=tenant_id,
                scope="workspace",
                key="workspace.created",
                old_value=None,
                new_value={"name": body["name"], "llm": f"{provider}/{model}"},
                actor=actor,
            )
        )
    log.info("onboarding.workspace_created", tenant_id=str(tenant_id))
    welcome = await auth_service.send_welcome(
        email, body["owner_name"].strip(), body["name"].strip(), body.get("locale", "en")
    )
    return {"status": "ok", "id": str(tenant_id), "welcome": welcome}


async def resend_welcome(actor: str, tenant_id: uuid.UUID) -> dict[str, Any]:
    """Send the owner a fresh set-your-password link (the old ones stay valid until they expire
    or one is used)."""
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        owner = await s.scalar(select(Person).where(Person.app_role == "owner"))
    if tenant is None or owner is None:
        raise NotFound("workspace owner")
    out = await auth_service.send_welcome(owner.email, owner.name, tenant.name, owner.locale)
    await console._log(actor, "workspace", "onboarding.welcome_sent", None,
                       {"to": owner.email}, tenant_id)  # fmt: skip
    return out


def _conn(wc: WarehouseConnection) -> ConnectionConfig:
    return ConnectionConfig(
        account=wc.account_identifier,
        user=wc.user_name,
        role=wc.role_name,
        warehouse=wc.warehouse_name,
        database=wc.database_name,
        secret_ref=wc.secret_ref,
    )


def mock_connection_available() -> bool:
    s = get_settings()
    return lab() or (s.env == "local" and bool(s.mock_warehouse_database))


async def lab_snapshots(tenant_id: uuid.UUID) -> dict[str, Any]:
    """The saved warehouse profiles the lab can replay, newest first, with the recommended one.

    A snapshot is the shape-only profile stored on a discovery run (names, types, counts; no
    rows). Runs that replayed the same profile count once. Recommended = the profile whose
    guide came from the newest discovery agent, then the one with the most tables."""
    saved = [r for r in await _lab_prior(tenant_id, "discovery") if (r.input or {}).get("profile")]
    seen: dict[tuple[Any, int, int], dict[str, Any]] = {}
    for r in saved:
        p = r.input["profile"]
        key = (p.get("database"), len(p.get("tables", [])), len(p.get("semantic_views", [])))
        if key in seen:
            continue
        out = r.output or {}
        seen[key] = {
            "id": str(r.id),
            "database": p.get("database"),
            "tables": key[1],
            "views": key[2],
            "guide": f"{r.agent_key} v{r.agent_version}" if r.agent_key else None,
            "guide_version": r.agent_version or 0,
            "summary": out.get("summary", ""),
            "approved": r.status == "approved",
            "saved_at": r.created_at.isoformat(),
        }
    items = list(seen.values())
    best = max(items, key=lambda x: (x["guide_version"], x["tables"]), default=None)
    async with tenant_tx("service", tenant_id) as s:
        wc = await s.scalar(select(WarehouseConnection))
    chosen = (wc.test_result or {}).get("snapshot_id") if wc else None
    ids = {x["id"] for x in items}
    selected = chosen if chosen in ids else (best["id"] if best else None)
    for x in items:
        x["recommended"] = bool(best and x["id"] == best["id"])
    return {"items": items, "selected": selected}


async def select_snapshot(actor: str, tenant_id: uuid.UUID, snapshot_id: str) -> dict[str, Any]:
    if not lab():
        raise Conflict("snapshots exist only in the lab")
    snaps = await lab_snapshots(tenant_id)
    if snapshot_id not in {x["id"] for x in snaps["items"]}:
        raise NotFound("snapshot")
    async with tenant_tx("service", tenant_id) as s:
        wc = await s.scalar(select(WarehouseConnection))
        if wc is None:
            raise Conflict("connect first")
        wc.test_result = {**(wc.test_result or {}), "snapshot_id": snapshot_id}
    await console._log(actor, "workspace", "lab.snapshot_selected", None, snapshot_id, tenant_id)
    return {"status": "ok", "selected": snapshot_id}


async def connect_mock(actor: str, tenant_id: uuid.UUID) -> dict[str, Any]:
    """Local: connect to the fakesnow mock warehouse (preset from .env). Lab: pretend-connect to
    the saved DavidsTea warehouse (the snapshot is replayed, nothing is queried)."""
    if not mock_connection_available():
        raise Conflict("no local mock warehouse is configured")
    if lab():
        snaps = await lab_snapshots(tenant_id)
        db = next((x["database"] for x in snaps["items"] if x["id"] == snaps["selected"]), None)
        out = await save_connection(actor, tenant_id, {
            "account_identifier": "davidstea-lab", "user_name": "FORMADA_SVC",
            "role_name": "FORMADA_READONLY", "warehouse_name": "FORMADA_WH",
            "database_name": db or "DAVIDSTEA",
            "secret_ref": "lab/snapshot", "monthly_credit_cap": 25,
        })  # fmt: skip
        if snaps["selected"]:
            await select_snapshot(actor, tenant_id, snaps["selected"])
        return out
    s = get_settings()
    return await save_connection(actor, tenant_id, {
        "account_identifier": "local-mock", "user_name": "FORMADA_SVC",
        "role_name": "READ_ONLY", "warehouse_name": "LOCAL_MOCK",
        "database_name": s.mock_warehouse_database,
        "schemas": [x.strip() for x in s.mock_warehouse_schemas.split(",") if x.strip()],
        "secret_ref": "", "monthly_credit_cap": 25,
    })  # fmt: skip


async def save_connection(
    actor: str, tenant_id: uuid.UUID, body: dict[str, Any], warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    for key in ("account_identifier", "user_name", "role_name", "warehouse_name", "database_name"):
        if not str(body.get(key, "")).strip():
            raise Invalid(f"{key} is required")
    ob.check_ident(body["database_name"].strip())
    await onboarding_collab.require_team_can_work(tenant_id, "connect")
    async with tenant_tx("service", tenant_id) as s:
        if await s.get(Tenant, tenant_id) is None:
            raise NotFound("workspace")
        wc = await s.scalar(select(WarehouseConnection))
        if wc is None:
            wc = WarehouseConnection(tenant_id=tenant_id)
            s.add(wc)
        wc.account_identifier = body["account_identifier"].strip()
        wc.user_name = body["user_name"].strip()
        wc.role_name = body["role_name"].strip()
        wc.warehouse_name = body["warehouse_name"].strip()
        wc.database_name = body["database_name"].strip().upper()
        wc.schemas = [x.strip().upper() for x in body.get("schemas", []) if x.strip()]
        wc.secret_ref = body.get("secret_ref", "").strip() or f"tenant/{tenant_id}/snowflake_key"
        wc.monthly_credit_cap = Decimal(str(body.get("monthly_credit_cap", 25)))
        wc.status = "pending"
        conn = _conn(wc)
    started = datetime.now(UTC)
    result: dict[str, Any]
    try:
        await (warehouse or _warehouse()).ping(conn)
        status, result = "ok", {"ok": True}
    except Exception as exc:  # any connector error is a failed test, shown to the team
        status, result = "failed", {"ok": False, "error": str(exc)[:500]}
    async with tenant_tx("service", tenant_id) as s:
        wc = await s.scalar(select(WarehouseConnection))
        assert wc is not None
        keep = (wc.test_result or {}).get("snapshot_id")
        wc.status, wc.last_tested_at = status, started
        wc.test_result = {**result, "snapshot_id": keep} if keep else result
    await console._log(actor, "workspace", "warehouse_connection", None, conn.database, tenant_id)
    return {"status": status, **result}


# ---------------------------------------------------------------------------------------------
# State
# ---------------------------------------------------------------------------------------------


def _with_links(row: OnboardingStep) -> dict[str, Any] | None:
    """A discovery answer always carries its links (older ones get them from their profile)."""
    if row.step == "mapping" and row.output:
        given = row.input or {}
        marks = mapping_benchmark.run(row.output, given.get("profile"), given.get("archetypes"))
        return {**row.output, "context_benchmark": marks}
    if row.step != "discovery" or not row.output:
        return row.output
    profile = (row.input or {}).get("profile")
    full = dc.with_links(row.output, profile)
    return {
        **full,
        "link_checks": dc.link_checks(full, profile),
        "context_benchmark": benchmark.run(full, profile),
    }


def _add_plan_benchmarks(
    latest: dict[str, dict[str, Any]], rows: Sequence[OnboardingStep], running: set[str]
) -> None:
    """Benchmarks of the org web and the metrics plan, judged against what each step was shown."""
    first: dict[str, OnboardingStep] = {}
    for r in rows:  # newest first, so the first row of a step is the one shown
        first.setdefault(r.step, r)
    org, metrics = latest.get("org"), latest.get("metrics")
    mapping = (latest.get("mapping") or {}).get("output")
    if org and org.get("output") and "roles" in org["output"]:
        seen = (first["org"].input or {}) if "org" in first else {}
        org["output"] = {
            **org["output"],
            "context_benchmark": plan_benchmark.run_org(
                org["output"], seen.get("role_archetypes"), mapping
            ),
        }
    if metrics and metrics.get("output") and "metrics" in metrics["output"]:
        seen = (first["metrics"].input or {}) if "metrics" in first else {}
        org_seen = (first["org"].input or {}) if "org" in first else {}
        metrics["output"] = {
            **metrics["output"],
            "context_benchmark": plan_benchmark.run_metrics(
                metrics["output"],
                seen.get("roles"),
                {str(t.get("key")) for t in seen.get("templates", [])}
                | set(template_shapes())
                | running,
                template_shapes(),
                mapping,
                org_seen.get("role_archetypes"),
            ),
        }


def _step_view(row: OnboardingStep) -> dict[str, Any]:
    cost = estimated_cost(row.model or "", row.input_tokens + row.output_tokens)
    return {
        "id": str(row.id),
        "step": row.step,
        "status": row.status,
        "output": _with_links(row),
        "checks": row.checks,
        "notes": row.notes,
        "agent": f"{row.agent_key} v{row.agent_version}" if row.agent_key else None,
        "model": f"{row.provider}/{row.model}" if row.model else None,
        "tokens": {"input": row.input_tokens, "output": row.output_tokens},
        "cost_usd": cost,
        "latency_ms": row.latency_ms,
        "error": row.error,
        "has_trace": bool(row.trace),
        "created_by": row.created_by,
        "created_at": row.created_at.isoformat(),
        "approved_by": row.approved_by,
        "approved_at": row.approved_at.isoformat() if row.approved_at else None,
        "applied": row.applied,
        "input_summary": _input_summary(row),
    }


def _input_summary(row: OnboardingStep) -> dict[str, Any]:
    """What the agent was sent, sized for the console (the full input stays in the database)."""
    data = row.input or {}
    text = json.dumps(data, default=str)
    return {"bytes": len(text), "keys": sorted(data.keys())}


async def state(tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFound("workspace")
        now = datetime.now(UTC)
        stopped = "The step stopped before it finished (the server restarted). Run it again."
        await s.execute(
            update(OnboardingStep)
            .where(
                OnboardingStep.status == "running",
                OnboardingStep.created_at < now - STALE_RUNNING,
            )
            .values(status="failed", error=ob.failure_text(stopped))
        )
        if lab():
            # One API process runs every step, so a "running" step with no live task is orphaned
            # (the free host restarted or slept): fail it now instead of showing a spinner.
            await s.execute(
                update(OnboardingStep)
                .where(
                    OnboardingStep.status == "running",
                    OnboardingStep.created_at < now - ORPHAN_GRACE,
                    OnboardingStep.id.not_in(list(_running)),
                )
                .values(status="failed", error=ob.failure_text(stopped))
            )
        wc = await s.scalar(select(WarehouseConnection))
        rows = (
            await s.scalars(select(OnboardingStep).order_by(OnboardingStep.created_at.desc()))
        ).all()
        mappings = (await s.scalars(select(ArchetypeMapping))).all()
        roles = (await s.scalars(select(RoleNode))).all()
        departments = (await s.scalars(select(Department).order_by(Department.sort_order))).all()
        metrics = (await s.scalars(select(Metric).order_by(Metric.key))).all()
        role_metrics = (await s.scalars(select(RoleMetric))).all()
        overrides = (await s.scalars(select(RulesConfig))).all()
        llm = await s.scalar(select(LlmSetting))
        owner = await s.scalar(select(Person).where(Person.app_role == "owner"))
    latest: dict[str, dict[str, Any]] = {}
    history: dict[str, list[dict[str, Any]]] = {k: [] for k in AGENTS}
    for r in rows:
        if r.step not in latest:
            latest[r.step] = _step_view(r)
        history[r.step].append(
            {"id": str(r.id), "status": r.status, "created_at": r.created_at.isoformat()}
        )
    _add_plan_benchmarks(latest, rows, {m.sql_template_key for m in metrics})
    titles = {r.id: r.title for r in roles}
    by_metric: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for rm in role_metrics:
        by_metric.setdefault(rm.metric_id, []).append(
            {
                "role": titles.get(rm.role_node_id, ""),
                "weight": float(rm.weight),
                "threshold": float(rm.threshold) if rm.threshold is not None else None,
                "daily_check": rm.daily_check,
            }
        )
    done = {
        "connect": bool(wc and wc.status == "ok"),
        "discovery": any(r.step == "discovery" and r.status == "approved" for r in rows),
        "mapping": bool(mappings),
        "org": bool(roles),
        "metrics": bool(metrics),
        "rules": any(r.step == "rules" and r.status == "approved" for r in rows),
    }
    return {
        "workspace": {
            "id": str(tenant.id),
            "name": tenant.name,
            "currency": tenant.currency,
            "timezone": tenant.timezone,
            "locale": tenant.locale,
            "owner": {"name": owner.name, "email": owner.email} if owner else None,
            "llm": f"{llm.provider}/{llm.model}" if llm else None,
        },
        "mock_connection": mock_connection_available(),
        "lab": await lab_snapshots(tenant_id) if lab() else None,
        "template_shapes": template_shapes(),
        "connection": {
            "account_identifier": wc.account_identifier,
            "user_name": wc.user_name,
            "role_name": wc.role_name,
            "warehouse_name": wc.warehouse_name,
            "database_name": wc.database_name,
            "schemas": wc.schemas,
            "secret_ref": wc.secret_ref,
            "monthly_credit_cap": float(wc.monthly_credit_cap),
            "status": wc.status,
            "test_result": wc.test_result,
            "last_tested_at": wc.last_tested_at.isoformat() if wc.last_tested_at else None,
        }
        if wc
        else None,
        "done": done,
        "steps": latest,
        "history": history,
        "mappings": [
            {"archetype": m.archetype_key, "source": m.source, "fields": len(m.columns)}
            for m in mappings
        ],
        "org": {
            "departments": [{"name": d.name, "playbook": d.playbook} for d in departments],
            "roles": [
                {
                    "id": str(r.id),
                    "title": r.title,
                    "archetype": r.role_archetype_key,
                    "parent": titles.get(r.parent_role_id) if r.parent_role_id else None,
                    "holder_type": r.holder_type,
                }
                for r in roles
            ],
        },
        "metrics": [
            {
                "key": m.key,
                "name": m.name,
                "template": f"{m.sql_template_key} v{m.sql_template_version}",
                "unit": m.unit,
                "higher_is_better": m.higher_is_better,
                "unit_value": float(m.unit_value),
                "roles": by_metric.get(m.id, []),
            }
            for m in metrics
        ],
        "rules": [{"key": o.key, "value": o.value} for o in overrides],
    }


# ---------------------------------------------------------------------------------------------
# Running an agent step
# ---------------------------------------------------------------------------------------------


async def _connection(tenant_id: uuid.UUID) -> ConnectionConfig:
    async with tenant_tx("service", tenant_id) as s:
        wc = await s.scalar(select(WarehouseConnection))
    if wc is None or wc.status != "ok":
        raise Conflict("connect and test the warehouse first")
    return _conn(wc)


async def _latest(tenant_id: uuid.UUID, step: str, approved: bool = False) -> OnboardingStep:
    async with tenant_tx("service", tenant_id) as s:
        q = select(OnboardingStep).where(OnboardingStep.step == step)
        q = q.where(
            OnboardingStep.status == "approved"
            if approved and not lab()
            else OnboardingStep.status.in_(("proposed", "approved"))
        )
        row = await s.scalar(q.order_by(OnboardingStep.created_at.desc()).limit(1))
    if row is None:
        raise Conflict(f"the {step} step needs {'an approved' if approved else 'a'} proposal first")
    return row


async def _start(
    actor: str,
    tenant_id: uuid.UUID,
    step: str,
    notes: str,
    work: Callable[[uuid.UUID], Awaitable[None]],
) -> dict[str, Any]:
    await onboarding_collab.require_team_can_work(tenant_id, step)
    async with tenant_tx("service", tenant_id) as s:
        if await s.get(Tenant, tenant_id) is None:
            raise NotFound("workspace")
        busy = await s.scalar(
            select(func.count())
            .select_from(OnboardingStep)
            .where(OnboardingStep.step == step, OnboardingStep.status == "running")
        )
        if busy:
            raise Conflict(f"a {step} proposal is already running")
        row = OnboardingStep(
            tenant_id=tenant_id, step=step, status="running", notes=notes, created_by=actor
        )
        s.add(row)
        await s.flush()
        step_id = row.id

    async def run() -> None:
        try:
            await work(step_id)
        except Exception as exc:  # the step shows the error; the console can retry
            log.warning("onboarding.step_failed", step=step, error=str(exc)[:300])
            async with tenant_tx("service", tenant_id) as s:
                await s.execute(
                    update(OnboardingStep)
                    .where(OnboardingStep.id == step_id)
                    .values(status="failed", error=ob.failure_text(str(exc)))
                )

    task = asyncio.create_task(run())
    _running[step_id] = task
    task.add_done_callback(lambda _t: _running.pop(step_id, None))
    return {"status": "started", "step_id": str(step_id)}


async def cancel_step(actor: str, tenant_id: uuid.UUID, step: str) -> dict[str, Any]:
    """Stop a step that is running (or looks stuck) so it can be started again."""
    async with tenant_tx("service", tenant_id) as s:
        rows = (
            await s.scalars(
                select(OnboardingStep).where(
                    OnboardingStep.step == step, OnboardingStep.status == "running"
                )
            )
        ).all()
        for r in rows:
            task = _running.get(r.id)
            if task is not None:
                task.cancel()
            r.status, r.error = "failed", f"Stopped by {actor}. Run this step again."
    return {"status": "ok", "stopped": len(rows)}


async def _latest_output(tenant_id: uuid.UUID, step: str) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        rows = (
            await s.scalars(
                select(OnboardingStep)
                .where(
                    OnboardingStep.step == step,
                    OnboardingStep.status.in_(("proposed", "superseded", "approved")),
                )
                .order_by(OnboardingStep.created_at.desc())
                .limit(1)
            )
        ).all()
    return dict(rows[0].output or {}) if rows else {}


async def _locked_items(
    tenant_id: uuid.UUID, step: str
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """The items our team fixed in the latest proposal of a step, and their checks (mapping)."""
    if step not in ITEMS:
        return [], {}
    field, key = ITEMS[step]
    async with tenant_tx("service", tenant_id) as s:
        rows = (
            await s.scalars(
                select(OnboardingStep)
                .where(
                    OnboardingStep.step == step,
                    OnboardingStep.status.in_(("proposed", "superseded", "approved")),
                )
                .order_by(OnboardingStep.created_at.desc())
                .limit(1)
            )
        ).all()
    if not rows or not rows[0].output:
        return [], {}
    out = rows[0].output
    locked = set(out.get("locked", []))
    items = [i for i in out.get(field, []) if i.get(key) in locked]
    checks = {
        k: v for k, v in ((rows[0].checks or {}).get("archetypes") or {}).items() if k in locked
    }
    return items, checks


async def _ask(
    tenant_id: uuid.UUID, step_id: uuid.UUID, step: str, payload: dict[str, Any],
    schema: type[BaseModel], fake: BaseModel, retry: bool = False,
) -> BaseModel | None:  # fmt: skip
    """Call the step's agent with the payload; record tokens, model and the raw answer.
    A retry keeps the first call's input on the step and adds its tokens to the total."""
    fixed, _ = await _locked_items(tenant_id, step)
    if fixed:
        # The team fixed these by hand or with a targeted AI edit: build around them, unchanged.
        note = (
            "Keep every item in fixed_by_team exactly as given; code restores them after your "
            "answer. Design the rest around them."
        )
        payload = {**payload, "fixed_by_team": fixed, "fixed_note": note}
    async with tenant_tx("service", tenant_id) as s:
        found = await agent_repo.active(s, AGENTS[step])
        if found is None:
            raise Conflict(f"agent {AGENTS[step]} is not loaded: run make seed")
        agent, prompt = found
        choice = await _choice(s, agent)
    user = json.dumps(payload, ensure_ascii=False, default=str)
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body, user, schema, fake=fake, effort="medium", timeout_s=AGENT_TIMEOUT_S
    )
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, step_id)
        assert row is not None
        if not retry:
            row.input = payload
        row.agent_key, row.agent_version = agent.key, prompt.version
        row.provider, row.model = result.provider, result.model
        before = (row.input_tokens, row.output_tokens, row.latency_ms) if retry else (0, 0, 0)
        row.input_tokens = before[0] + result.input_tokens
        row.output_tokens = before[1] + result.output_tokens
        row.latency_ms = before[2] + result.latency_ms
        row.trace = {
            "thinking": result.thinking[:60000],
            "effort": "medium",
            "system_chars": len(prompt.body),
            "user_chars": len(user),
            "fixed_by_team": len(fixed),
        }
        if result.parsed is None:
            row.status, row.error = "failed", ob.failure_text(result.error or "no answer")
            row.output = {"raw": result.raw[:20000]} if result.raw else None
    log.info(
        "onboarding.agent",
        step=step,
        model=result.model,
        tokens=result.input_tokens + result.output_tokens,
        ok=result.parsed is not None,
    )
    return result.parsed


async def _finish(
    tenant_id: uuid.UUID, step_id: uuid.UUID, output: dict[str, Any], checks: dict[str, Any]
) -> None:
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, step_id)
        assert row is not None
        step = row.step
    if step in ITEMS and "locked" not in output:
        output, checks = await _restore_locked(tenant_id, step, output, checks)
    # Discovery: a whole new analysis is a fresh start. It ignores which cards were locked or
    # unlocked and uses only the profile and the team's notes. Locks protect targeted changes
    # (the per-tab rerun and the chat), not a full rerun.
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, step_id)
        assert row is not None
        await s.execute(
            update(OnboardingStep)
            .where(
                OnboardingStep.step == row.step,
                OnboardingStep.status == "proposed",
                OnboardingStep.id != step_id,
            )
            .values(status="superseded")
        )
        row.output, row.checks, row.status = output, checks, "proposed"


async def _restore_locked(
    tenant_id: uuid.UUID, step: str, output: dict[str, Any], checks: dict[str, Any]
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Put the team's locked items back into a fresh agent answer, replacing the agent's."""
    fixed, fixed_checks = await _locked_items(tenant_id, step)
    field, key = ITEMS[step]
    keys = {i[key] for i in fixed}
    items = [i for i in output.get(field, []) if i.get(key) not in keys] + fixed
    previous = await _latest_output(tenant_id, step)
    confirmed = sorted(set(previous.get("confirmed", [])) & keys)
    output = {**output, field: items, "locked": sorted(keys), "confirmed": confirmed}
    if fixed_checks:
        checks = {**checks, "archetypes": {**(checks.get("archetypes") or {}), **fixed_checks}}
    return output, checks


async def _rules(tenant_id: uuid.UUID) -> Any:
    async with tenant_tx("service", tenant_id) as s:
        return await org_repo.rules(s)


async def _q(
    wh: WarehouseClient, conn: ConnectionConfig, sql: str, tag: str, cap: int = PROFILE_CAP,
    params: dict[str, Any] | None = None, timeout_s: int = 300,
) -> list[dict[str, Any]]:  # fmt: skip
    # No parameters: pass None so a literal % in agent-written SQL is not read as a placeholder.
    result = await wh.query(
        conn,
        sql,
        params or None,  # type: ignore[arg-type]
        f"formada:onboarding:{tag}",
        timeout_s,
        cap,
    )
    return result.rows


# ---------------------------------------------------------------------------------------------
# 1. Discovery: profile the warehouse (shape only), then the data guide
# ---------------------------------------------------------------------------------------------


async def build_profile(
    wh: WarehouseClient,
    conn: ConnectionConfig,
    join_budget: int = 40,
    min_overlap_pct: float = 90.0,
) -> dict[str, Any]:
    db = conn.database
    tables: dict[str, ob.TableShape] = {}
    for r in await _q(wh, conn, ob.tables_sql(db), "tables"):
        t = ob.TableShape(r["table_schema"].upper(), r["table_name"].upper(), r["table_type"])
        tables[t.qualified] = t
    for r in await _q(wh, conn, ob.columns_sql(db), "columns"):
        key = f"{r['table_schema'].upper()}.{r['table_name'].upper()}"
        if key in tables:
            tables[key].columns.append(ob.Column(r["column_name"].upper(), r["data_type"]))
    shapes = [t for t in tables.values() if t.columns]

    stats: dict[str, list[dict[str, Any]]] = {}
    rows: dict[str, int] = {}
    profile_tables: list[dict[str, Any]] = []
    categories: list[dict[str, Any]] = []
    keywords: list[dict[str, Any]] = []
    for t in shapes:
        row = (await _q(wh, conn, ob.table_profile_sql(db, t), f"profile:{t.name}"))[0]
        stats[t.qualified] = ob.column_stats(t, row)
        rows[t.qualified] = int(row.get("n_rows") or 0)
        profile_tables.append(
            {"table": t.qualified, "type": t.kind, "rows": rows[t.qualified],
             "columns": stats[t.qualified]}
        )  # fmt: skip
        for col in ob.category_candidates(t, stats[t.qualified]):
            values = await _q(wh, conn, ob.categories_sql(db, t, col), f"categories:{t.name}")
            categories.append(
                {"table": t.qualified, "column": col,
                 "values": [{"value": v["value"], "rows": int(v["n"])} for v in values]}
            )  # fmt: skip
        for col in ob.keyword_candidates(t, stats[t.qualified]):
            kw = (await _q(wh, conn, ob.keywords_sql(db, t, col), f"keywords:{t.name}"))[0]
            if counts := ob.keyword_counts(kw):
                keywords.append({"table": t.qualified, "column": col, "keywords": counts})

    time_profile: dict[str, Any] | None = None
    picked = ob.pick_time_table(shapes, stats, rows)
    if picked:
        t, date_col, entity_cols = picked
        by_date: list[dict[str, Any]] = [
            {"date": str(r["d"])[:10], "rows": int(r["n_rows"]),
             **{entity_cols[i]: int(r[f"e_{i}"]) for i in range(len(entity_cols))}}
            for r in await _q(wh, conn, ob.time_profile_sql(db, t, date_col, entity_cols), "time")
        ]  # fmt: skip
        first = (await _q(wh, conn, ob.first_filled_sql(db, t, date_col), "first_filled"))[0]
        first_filled = [
            {"column": c.name, "first_date": ob._iso(first.get(f"f_{i}"))}
            for i, c in enumerate(t.columns)
        ]
        overall_first = by_date[0]["date"] if by_date else None
        mixes = []
        for cat in categories:
            if cat["table"] != t.qualified or len(cat["values"]) > 8:
                continue
            raw = await _q(wh, conn, ob.mix_sql(db, t, date_col, cat["column"]), "mix")
            mixes.append({"column": cat["column"], "changes": _mix_changes(raw)})
        dates = [date.fromisoformat(d["date"]) for d in by_date]
        time_profile = {
            "table": t.qualified,
            "date_column": date_col,
            "entity_columns": entity_cols,
            "cadence": ob.cadence(dates),
            "by_date": by_date,
            "row_breaks": ob.breaks(by_date, "rows"),
            "columns_filled_late": [
                f for f in first_filled if f["first_date"] and f["first_date"] != overall_first
            ],
            "category_mix_changes": mixes,
        }
    keys = ob.key_candidates(profile_tables)
    semantic_views = await _semantic_views(wh, conn)
    measured_views = await _measure_views(wh, conn, semantic_views)
    key_overlaps = await _key_overlaps(wh, conn, semantic_views, time_profile)
    comments = await _comments(wh, conn, tables)
    joins = await _test_joins(wh, conn, profile_tables, keys, join_budget, min_overlap_pct)
    return {
        "database": db,
        "tables": profile_tables,
        "key_candidates": keys,
        "joins": joins,
        "twin_tables": ob.table_twins(profile_tables),
        "semantic_views": semantic_views,
        "semantic_views_measured": measured_views,
        "key_overlaps": key_overlaps,
        "comments": comments,
        "categories": categories,
        "name_keywords": keywords,
        "time_profile": time_profile,
        "privacy": "shape only: names, types, counts, ratios, date ranges, categorical codes; "
        "no rows, no amounts, no free-text values",
    }


async def _semantic_views(wh: WarehouseClient, conn: ConnectionConfig) -> list[dict[str, Any]]:
    """The semantic views the role can see, as names, types and metric formulas (no data).

    Best effort: a warehouse without semantic views (or an emulator) answers with an error,
    which only means there is nothing to list."""
    db, cap = conn.database, 20000
    try:
        views = await _q(wh, conn, semantic.views_sql(db), "semantic:views", cap)
        if not views:
            return []
        parts = [
            await _q(wh, conn, sql, f"semantic:{name}", cap)
            for name, sql in (
                ("tables", semantic.tables_sql(db)),
                ("dimensions", semantic.dimensions_sql(db)),
                ("metrics", semantic.metrics_sql(db)),
                ("relationships", semantic.relationships_sql(db)),
            )
        ]
    except Exception as exc:
        log.info("semantic.views.unavailable", error=str(exc)[:160])
        return []
    return semantic.summarize(views, *parts)


async def _measure_views(
    wh: WarehouseClient, conn: ConnectionConfig, views: list[dict[str, Any]]
) -> int:
    """Measure each fact table of every semantic view: first and last date, how many dates, and
    how filled its identifying fields are over the last 30 days. Read-only aggregates, best effort:
    a fact that cannot be measured keeps no `measured` entry. Returns how many were measured."""
    done = 0
    for v in views:
        for t in v["tables"]:
            if not t["metrics"]:
                continue
            date_dim, measure = semantic.pick_date_dim(t), semantic.pick_measure(t)
            if not date_dim or not measure:
                continue
            dims = semantic.pick_key_dims(t, date_dim)
            try:
                range_q = semantic.range_sql(
                    conn.database, v["view"], t["table"], date_dim, measure
                )
                rng = (await _q(wh, conn, range_q, f"semantic:range:{t['table']}", 1,
                                timeout_s=180))[0]  # fmt: skip
                fill = None
                if rng.get("last_date") and dims:
                    since = (
                        date.fromisoformat(str(rng["last_date"])[:10]) - timedelta(days=30)
                    ).isoformat()
                    fill = (await _q(wh, conn, semantic.fill_sql(conn.database, v["view"],
                            t["table"], date_dim, dims, measure, since),
                            f"semantic:fill:{t['table']}", 1, timeout_s=180))[0]  # fmt: skip
            except Exception as exc:
                log.info("semantic.measure_skipped", table=t["table"], error=str(exc)[:160])
                continue
            t["measured"] = {"date_field": date_dim, "measure": measure,
                             **semantic.summarize_measure(rng, fill, dims)}  # fmt: skip
            done += 1
    return done


async def _key_overlaps(
    wh: WarehouseClient, conn: ConnectionConfig, views: list[dict[str, Any]],
    time_profile: dict[str, Any] | None,
) -> list[dict[str, Any]]:  # fmt: skip
    """Do the item codes of the biggest readable table also appear in each measured view fact?
    Item codes that differ make stock and sales impossible to join by item."""
    if not time_profile:
        return []
    out: list[dict[str, Any]] = []
    left_cols = [c for c in time_profile["entity_columns"] if semantic.ITEM_LIKE.match(c)]
    for v in views:
        for t in v["tables"]:
            m = t.get("measured")
            items = semantic.item_dims(t)
            if not m or not m.get("last_date") or not items or not left_cols:
                continue
            since = (date.fromisoformat(m["last_date"]) - timedelta(days=30)).isoformat()
            for col in left_cols:
                if len(out) >= semantic.OVERLAP_PROBES:
                    return out
                try:
                    sql = semantic.codes_overlap_sql(
                        semantic.table_codes_sql(conn.database, time_profile["table"], col,
                                                 time_profile["date_column"], 30),
                        semantic.view_codes_sql(conn.database, v["view"], t["table"], items[0],
                                                m["date_field"], m["measure"], since),
                    )  # fmt: skip
                    row = (await _q(wh, conn, sql, f"semantic:overlap:{t['table']}", 1,
                                    timeout_s=180))[0]  # fmt: skip
                except Exception as exc:
                    log.info("semantic.overlap_skipped", table=t["table"], error=str(exc)[:160])
                    continue
                left = f"{time_profile['table']}.{col}"
                right = f"{v['view']}.{t['table']}.{items[0]}"
                out.append(semantic.summarize_overlap(left, right, row))
    return out


async def _comments(
    wh: WarehouseClient, conn: ConnectionConfig, tables: dict[str, ob.TableShape]
) -> list[dict[str, Any]]:  # fmt: skip
    """Short descriptions the customer wrote on their tables' columns (best effort)."""
    try:
        rows = await _q(wh, conn, ob.comments_sql(conn.database), "comments", 400)
    except Exception as exc:
        log.info("comments.unavailable", error=str(exc)[:160])
        return []
    return [
        {"table": f"{r['table_schema']}.{r['table_name']}".upper(), "column": r["column_name"],
         "comment": str(r["comment"])[:140]}
        for r in rows
        if f"{r['table_schema']}.{r['table_name']}".upper() in tables
    ][:200]  # fmt: skip


async def _test_joins(
    wh: WarehouseClient, conn: ConnectionConfig, tables: list[dict[str, Any]],
    keys: dict[str, list[str]], budget: int, min_overlap_pct: float,
) -> list[dict[str, Any]]:  # fmt: skip
    """Test each candidate join against the data: how many of its values the key side holds."""
    out: list[dict[str, Any]] = []
    for c in ob.join_candidates(tables, keys, budget):
        try:
            row = (await _q(wh, conn, ob.join_probe_sql(conn.database, c), "join-probe", 1))[0]
            out.append({**c.as_dict(), **ob.judge_join(row, min_overlap_pct)})
        except Exception as exc:  # a type clash or a refused query: record it, keep going
            out.append({**c.as_dict(), "confirmed": False, "error": str(exc)[:200]})
    return out


def _mix_changes(raw: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Share of each code per date, kept only where the mix moves (first, last, and changes)."""
    by_date: dict[str, dict[str, int]] = {}
    for r in raw:
        by_date.setdefault(str(r["d"])[:10], {})[str(r["value"])] = int(r["n"])
    out: list[dict[str, Any]] = []
    previous: dict[str, float] = {}
    dates = sorted(by_date)
    for i, d in enumerate(dates):
        total = sum(by_date[d].values())
        shares = {k: round(100 * v / total, 1) for k, v in sorted(by_date[d].items())}
        moved = any(abs(shares.get(k, 0) - previous.get(k, 0)) >= 5 for k in shares | previous)
        if i in (0, len(dates) - 1) or moved:
            out.append(
                {"date": d, "share_pct": [{"value": k, "pct": v} for k, v in shares.items()]}
            )
        previous = shares
    return out


async def _archetypes() -> list[dict[str, Any]]:
    async with global_tx("service") as s:
        rows = (await s.scalars(select(DataArchetype).order_by(DataArchetype.key))).all()
    return [
        {"archetype": a.key, "description": a.description, "grain": list(ob.GRAIN.get(a.key, [])),
         "fields": [{"field": k, "meaning": v} for k, v in a.columns.items()]}
        for a in rows
    ]  # fmt: skip


async def start_discovery(
    actor: str, tenant_id: uuid.UUID, notes: str, warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    conn = await _connection(tenant_id)
    wh = warehouse or _warehouse()

    rules = await _rules(tenant_id)

    async def work(step_id: uuid.UUID) -> None:
        if lab():
            saved = await _lab_prior(tenant_id, "discovery")
            snaps = await lab_snapshots(tenant_id)
            pick = next((r for r in saved if str(r.id) == snaps["selected"]), None)
            if pick is None or not (pick.input or {}).get("profile"):
                raise Conflict("the lab has no saved profile: load a snapshot first")
            profile = pick.input["profile"]
        else:
            profile = await build_profile(
                wh, conn, rules.discovery_join_probe_budget, rules.discovery_join_min_overlap_pct
            )
        payload = {
            "today": date.today().isoformat(),
            "profile": profile,
            "standard_model": await _archetypes(),
            "team_notes": notes,
        }
        fake = DiscoveryOut(
            summary=f"{len(profile['tables'])} tables profiled.",
            tables=[], semantic_views=[], cadence="unclear", coverage=[],
            quality_issues=[], questions=[],
        )  # fmt: skip
        out = await _ask(tenant_id, step_id, "discovery", payload, DiscoveryOut, fake)
        if out is None:
            return
        data = out.model_dump()
        # Written by code, not the AI: every table of each view and every declared link.
        data["view_links"] = [semantic.graph(v) for v in profile.get("semantic_views", [])]
        # The links the views declare become cards the team can change. What the team removed,
        # changed or added before survives a new analysis: the customer's views have not changed.
        data["links"], data["removed_links"] = dc.fresh_links(
            profile, await _latest_output(tenant_id, "discovery")
        )
        await _finish(tenant_id, step_id, data, ob.check_discovery(data, profile).as_dict())

    return await _start(actor, tenant_id, "discovery", notes, work)


# ---------------------------------------------------------------------------------------------
# 2. Mapping: one SELECT per archetype, tested on the warehouse
# ---------------------------------------------------------------------------------------------


async def start_mapping(
    actor: str, tenant_id: uuid.UUID, notes: str, warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    conn = await _connection(tenant_id)
    discovery = await _latest(tenant_id, "discovery", approved=True)
    wh = warehouse or _warehouse()

    async def work(step_id: uuid.UUID) -> None:
        archetypes = await _archetypes()
        # The team's reviewed links, not only the ones the views declare.
        profile = dc.effective_profile(discovery.input["profile"], discovery.output or {})
        payload = {
            "today": date.today().isoformat(),
            "dialect": "Snowflake",
            "database": conn.database,
            "archetypes": archetypes,
            "profile": profile,
            "data_guide": discovery.output,
            "team_notes": [n for n in (discovery.notes, notes) if n],
        }
        fake = MappingOut(archetypes=[])
        out = await _ask(tenant_id, step_id, "mapping", payload, MappingOut, fake)
        if out is None:
            return
        data = out.model_dump()
        # A model can stop early and leave shapes out. Ask once more for just those.
        left_out = [a["archetype"] for a in archetypes if a["archetype"] not in
                    {p["archetype"] for p in data["archetypes"]}]  # fmt: skip
        if left_out:
            again = await _ask(
                tenant_id, step_id, "mapping",
                {**payload, "answer_only_for": left_out,
                 "note": "Your first answer left these data shapes out. Answer for exactly "
                         "these, one entry each, unmappable ones included."},
                MappingOut, fake, retry=True,
            )  # fmt: skip
            if again is not None:
                data["archetypes"] += [
                    p for p in again.model_dump()["archetypes"] if p["archetype"] in left_out
                ]
        checks = await check_mapping(wh, conn, tenant_id, data, profile, archetypes)
        data, checks = await _repair_mapping(
            wh, conn, tenant_id, step_id, payload, archetypes, profile, data, checks, fake
        )
        await _finish(tenant_id, step_id, data, checks)

    return await _start(actor, tenant_id, "mapping", notes, work)


async def _repair_mapping(
    wh: WarehouseClient, conn: ConnectionConfig, tenant_id: uuid.UUID, step_id: uuid.UUID,
    payload: dict[str, Any], archetypes: list[dict[str, Any]], profile: dict[str, Any],
    data: dict[str, Any], checks: dict[str, Any], fake: BaseModel,
) -> tuple[dict[str, Any], dict[str, Any]]:  # fmt: skip
    """One repair try: show the agent what the checks refused and let it fix just those shapes.

    A repaired shape keeps the refused SQL and its errors (`repaired_from`) so the team sees the
    difference; one that still fails stays as first proposed. Never approved automatically."""
    prior = {p["archetype"]: p for p in data["archetypes"]}
    failing = {
        n: r for n, r in checks["archetypes"].items()
        if not r.get("ok") and n in prior and prior[n]["status"] != "unmappable"
    }  # fmt: skip
    if not failing:
        return data, checks
    again = await _ask(
        tenant_id, step_id, "mapping",
        {**payload,
         "repair": [
             {"archetype": n, "your_source_sql": prior[n]["source_sql"], "errors": r["errors"]}
             for n, r in failing.items()
         ],
         "note": "The checks refused these mappings. Fix only these data shapes: return one "
                 "corrected entry for each, using only names the profile lists."},
        MappingOut, fake, retry=True,
    )  # fmt: skip
    if again is None:
        return data, checks
    fixed = {
        p["archetype"]: p for p in again.model_dump()["archetypes"] if p["archetype"] in failing
    }
    if not fixed:
        return data, checks
    rechecked = await check_mapping(
        wh, conn, tenant_id, {"archetypes": list(fixed.values())}, profile, archetypes
    )
    per = dict(checks["archetypes"])
    kept = dict(prior)
    for name, result in rechecked["archetypes"].items():
        refused = {"sql": prior[name]["source_sql"], "errors": failing[name]["errors"]}
        if result.get("ok"):
            kept[name] = fixed[name]
            per[name] = {**result, "repaired_from": refused}
        else:
            per[name] = {**failing[name], "repair_failed": result.get("errors", [])}
    order = [p["archetype"] for p in data["archetypes"]]
    out = {**data, "archetypes": [kept[n] for n in order]}
    return out, {**checks, "archetypes": per}


async def measure_mapping(
    wh: WarehouseClient, conn: ConnectionConfig, rules: Any, name: str, sql: str,
    fields: list[str], expected_null: set[str],
) -> tuple[ob.CheckReport, dict[str, Any]]:  # fmt: skip
    """Run a mapping's source on the warehouse and judge it: rows, fill per field, enum values,
    negatives and the grain. Used at onboarding and again at the start of every run."""
    report = ob.CheckReport()
    date_field = next((f for f in fields if f.endswith("_date")), None)
    test_sql = ob.mapping_test_sql(sql, fields, date_field)
    limit_s = rules.query_timeout_seconds
    test = (await _q(wh, conn, test_sql, f"map:{name}", 10, timeout_s=limit_s))[0]
    mixes = {
        f: await _q(wh, conn, ob.value_mix_sql(sql, f), f"mix:{name}", 30)
        for f in fields
        if f in ob.ENUM_FIELDS
    }
    quantities = [f for f in fields if ob.QUANTITY_HINT.search(f)]
    neg_row: dict[str, Any] = {}
    if quantities:
        neg_row = (await _q(wh, conn, ob.negatives_sql(sql, quantities), f"neg:{name}", 1))[0]
    negatives = {f: int(neg_row.get(f"neg_{i}") or 0) for i, f in enumerate(quantities)}
    live, fills = ob.judge_mapping_test(name, fields, test, mixes, negatives, expected_null)
    report.errors += live.errors
    report.warnings += live.warnings
    grain_entry: dict[str, Any] = {}
    grain = ob.GRAIN.get(name)
    if grain and not (set(grain) & expected_null) and int(test.get("n_rows") or 0):
        grain_row = (await _q(wh, conn, ob.grain_sql(sql, grain), f"grain:{name}", 1))[0]
        grain_report, grain_entry = ob.judge_grain(
            name, grain, grain_row, rules.mapping_grain_tolerance_pct
        )
        report.errors += grain_report.errors
        report.warnings += grain_report.warnings
    entry = {
        "rows": int(test.get("n_rows") or 0),
        "dates": int(test.get("dates") or 0) if date_field else None,
        "first_date": ob._iso(test.get("min_date")),
        "last_date": ob._iso(test.get("max_date")),
        "fills": fills,
        "grain": grain_entry or None,
        "value_mix": {
            f: [{"value": m["value"], "rows": int(m["n"])} for m in v] for f, v in mixes.items()
        },
    }
    return report, entry


async def _lab_saved_checks(tenant_id: uuid.UUID) -> dict[tuple[str, str], dict[str, Any]]:
    """(shape, normalised SQL) -> what a real run measured for exactly that SQL."""
    out: dict[tuple[str, str], dict[str, Any]] = {}
    for r in await _lab_prior(tenant_id, "mapping"):
        measured = (r.checks or {}).get("archetypes") or {}
        for p in (r.output or {}).get("archetypes", []):
            entry = measured.get(p["archetype"])
            if entry and entry.get("rows") is not None and p.get("source_sql"):
                out.setdefault((p["archetype"], _norm_sql(p["source_sql"])), entry)
    return out


def _lab_measure(
    prior: dict[tuple[str, str], dict[str, Any]], name: str, sql: str
) -> tuple[ob.CheckReport, dict[str, Any]]:
    """The saved measurement for this exact SQL, or a plain note that it was not run."""
    report = ob.CheckReport()
    saved = prior.get((name, _norm_sql(sql)))
    if saved:
        keep = {k: v for k, v in saved.items() if k not in ("ok", "errors", "warnings")}
        return report, {**keep, "lab_replayed": True}
    report.warnings.append(
        f"{name}: this SQL was not run: the lab has no live warehouse. "
        "The static checks passed; a real workspace runs it on Snowflake."
    )
    return report, {"lab_not_run": True}


async def check_mapping(
    wh: WarehouseClient, conn: ConnectionConfig, tenant_id: uuid.UUID, data: dict[str, Any],
    profile: dict[str, Any], archetypes: list[dict[str, Any]],
) -> dict[str, Any]:  # fmt: skip
    rules = await _rules(tenant_id)
    fields_of = {a["archetype"]: [f["field"] for f in a["fields"]] for a in archetypes}
    results: dict[str, Any] = {}
    prior = await _lab_saved_checks(tenant_id) if lab() else {}
    for p in data.get("archetypes", []):
        name = p["archetype"]
        if name not in fields_of:
            results[name] = {"ok": False, "errors": [f"unknown archetype {name}"], "warnings": []}
            continue
        fields = fields_of[name]
        report = ob.check_mapping_sql(name, fields, p, conn.database, profile)
        entry: dict[str, Any] = {}
        if p["status"] != "unmappable" and report.ok:
            sql = p["source_sql"].strip().rstrip(";")
            expected_null = {f["field"] for f in p["fields"] if not f.get("source_columns")}
            try:
                if lab():
                    live, entry = _lab_measure(prior, name, sql)
                else:
                    live, entry = await measure_mapping(
                        wh, conn, rules, name, sql, fields, expected_null
                    )
                report.errors += live.errors
                report.warnings += live.warnings
            except Exception as exc:  # the warehouse rejected the SQL: show its message
                report.errors.append(f"{name}: the warehouse refused the SQL: {str(exc)[:400]}")
        results[name] = {**report.as_dict(), **entry}
    await _cross_check_skus(wh, conn, rules, data, results)
    answered = {p["archetype"] for p in data.get("archetypes", [])}
    left_out = sorted(set(fields_of) - answered)
    errors = [f"{name}: the agent gave no answer for this data shape" for name in left_out]
    return {"archetypes": results, "ok": not errors, "errors": errors, "warnings": []}


async def _cross_check_skus(
    wh: WarehouseClient, conn: ConnectionConfig, rules: Any, data: dict[str, Any],
    results: dict[str, Any],
) -> None:  # fmt: skip
    """Stock and purchase mappings must use the same item codes as sales (changes `results`)."""
    props = {p["archetype"]: p for p in data.get("archetypes", [])}
    sales = props.get("sales_line")
    if not sales or not (results.get("sales_line") or {}).get("ok") or not sales["source_sql"]:
        return
    sales_codes = ob.sku_codes_sql(sales["source_sql"].strip().rstrip(";"), "sales_line")
    for shape in ("inventory_position", "purchase_order_line"):
        p, r = props.get(shape), results.get(shape)
        if not p or not r or not r.get("ok") or not p["source_sql"]:
            continue
        try:
            other = ob.sku_codes_sql(p["source_sql"].strip().rstrip(";"), shape)
            row = (await _q(wh, conn, ob.sku_overlap_sql(sales_codes, other), f"sku:{shape}", 1,
                            timeout_s=rules.query_timeout_seconds))[0]  # fmt: skip
        except Exception as exc:  # a refused query is reported by the other checks
            log.info("mapping.sku_check_skipped", shape=shape, error=str(exc)[:160])
            continue
        report, entry = ob.judge_sku_overlap(shape, row, rules.mapping_sku_overlap_min_pct)
        r["sku_overlap"] = entry
        if report.errors:
            r["errors"] = [*r.get("errors", []), *report.errors]
            r["ok"] = False


async def recheck_mapping(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, archetypes_in: list[dict[str, Any]],
    warehouse: WarehouseClient | None = None,
) -> dict[str, Any]:  # fmt: skip
    """The team edited a proposal's SQL: check it again, as a new proposal (no model call)."""
    await onboarding_collab.require_team_can_work(tenant_id, "mapping")
    conn = await _connection(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        base = await s.get(OnboardingStep, step_id)
    if base is None or base.step != "mapping" or not base.output:
        raise NotFound("mapping proposal")
    discovery = await _latest(tenant_id, "discovery", approved=True)
    edited = {a["archetype"]: a for a in archetypes_in}
    data = {
        "archetypes": [
            {**p, "source_sql": edited[p["archetype"]].get("source_sql", p["source_sql"]),
             "status": edited[p["archetype"]].get("status", p["status"])}
            if p["archetype"] in edited else p
            for p in base.output["archetypes"]
        ],
        "locked": sorted(set(base.output.get("locked", [])) | set(edited)),
    }  # fmt: skip
    checks = await check_mapping(
        warehouse or _warehouse(), conn, tenant_id, data, discovery.input["profile"],
        await _archetypes(),
    )  # fmt: skip
    async with tenant_tx("service", tenant_id) as s:
        row = OnboardingStep(
            tenant_id=tenant_id, step="mapping", status="running", created_by=actor,
            notes=f"edited from proposal {step_id}", input=base.input,
            agent_key=base.agent_key, agent_version=base.agent_version,
            provider=base.provider, model=base.model,
        )  # fmt: skip
        s.add(row)
        await s.flush()
        new_id = row.id
    await _finish(tenant_id, new_id, data, checks)
    return {"status": "ok", "step_id": str(new_id)}


# ---------------------------------------------------------------------------------------------
# 3. Org web
# ---------------------------------------------------------------------------------------------


async def _role_archetypes() -> list[dict[str, Any]]:
    async with global_tx("service") as s:
        rows = (await s.scalars(select(RoleArchetype).order_by(RoleArchetype.key))).all()
    return [
        {"key": a.key, "playbook": a.playbook, "title": a.definition.get("title", {}).get("en"),
         "decisions_owned": a.definition.get("decisions_owned", []),
         "decisions_forbidden": a.definition.get("decisions_forbidden", []),
         "kpi_notes": a.definition.get("kpi_notes")}
        for a in rows
    ]  # fmt: skip


async def start_org(actor: str, tenant_id: uuid.UUID, notes: str) -> dict[str, Any]:
    discovery = await _latest(tenant_id, "discovery", approved=True)
    draft = await onboarding_collab.approved_draft_nodes(tenant_id)

    async def work(step_id: uuid.UUID) -> None:
        archetypes = await _role_archetypes()
        payload = {
            "team_notes": notes,
            # The client's chart: titles and reporting lines only, never names (ADR 0027).
            "client_draft": org_import.for_agent(draft) if draft else [],
            "role_archetypes": archetypes,
            "playbooks": list(ob.PLAYBOOKS),
            "data_coverage": (discovery.output or {}).get("coverage", []),
            "data_summary": (discovery.output or {}).get("summary", ""),
        }
        fake = OrgOut(departments=[], roles=[], notes=[])
        out = await _ask(tenant_id, step_id, "org", payload, OrgOut, fake)
        if out is None:
            return
        data = out.model_dump()
        aligned: list[str] = []
        if draft:
            data, aligned = org_import.align_to_draft(data, draft)
        report = ob.check_org(data, {a["key"] for a in archetypes})
        report.warnings.extend(aligned)
        checks = {**report.as_dict(), "from_client_draft": bool(draft)}
        await _finish(tenant_id, step_id, data, checks)

    return await _start(actor, tenant_id, "org", notes, work)


async def _apply_org(tenant_id: uuid.UUID, out: dict[str, Any]) -> dict[str, Any]:
    """Writes the org web. After a reopen it updates the web built last time (matched by ref):
    roles kept are updated, new ones created, dropped ones removed. Nothing is reset."""
    async with global_tx("service") as s:
        archetypes = {a.key: a.definition for a in await s.scalars(select(RoleArchetype))}
    async with tenant_tx("service", tenant_id) as s:
        last = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == "org", OnboardingStep.status == "approved")
            .order_by(OnboardingStep.approved_at.desc())
            .limit(1)
        )
        prev: dict[str, str] = ((last.applied or {}).get("roles", {})) if last else {}
        existing = {r.id: r for r in await s.scalars(select(RoleNode))}
        if existing and not prev:
            raise Conflict("this workspace already has an org web")
        tenant = await s.get(Tenant, tenant_id)
        owner = await s.scalar(select(Person).where(Person.app_role == "owner"))
        assert tenant is not None
        depts = {d.name: d for d in await s.scalars(select(Department))}
        for i, d in enumerate(out["departments"]):
            dept = depts.get(d["name"])
            if dept is None:
                dept = Department(tenant_id=tenant_id, name=d["name"], playbook=d["playbook"],
                                  sort_order=len(depts) + i + 1)  # fmt: skip
                s.add(dept)
                await s.flush()
                depts[d["name"]] = dept
            else:
                dept.playbook = d["playbook"]
        roles: dict[str, uuid.UUID] = {}
        for r in out["roles"]:
            a = archetypes[r["archetype"]]
            root = not r.get("parent_ref")
            dept_obj = depts.get(r.get("department") or "")
            fields = {
                "department_id": dept_obj.id if dept_obj else None,
                "parent_role_id": roles.get(r.get("parent_ref") or ""),
                "title": r["title"][:120],
                "role_archetype_key": r["archetype"],
                "decisions_owned": a.get("decisions_owned", []),
                "decisions_forbidden": a.get("decisions_forbidden", []),
                "kpi_notes": a.get("kpi_notes"),
            }
            node = existing.get(uuid.UUID(prev[r["ref"]])) if r["ref"] in prev else None
            if node is not None:
                for k, v in fields.items():
                    setattr(node, k, v)
            else:
                node = RoleNode(
                    tenant_id=tenant_id, cadence="weekly", language=tenant.locale,
                    holder_type="human" if root and owner else "vacant", **fields,
                )  # fmt: skip
                s.add(node)
                await s.flush()
                if root and owner:
                    s.add(RoleAssignment(tenant_id=tenant_id, person_id=owner.id,
                                         role_node_id=node.id, permission="owner",
                                         is_primary=True))  # fmt: skip
            await s.flush()
            roles[r["ref"]] = node.id
        kept = set(roles.values())
        removed = [n for n in existing.values() if n.id not in kept]
        if removed:
            ids = [n.id for n in removed]
            for n in removed:
                n.parent_role_id = None
            await s.flush()
            await s.execute(delete(RoleAssignment).where(RoleAssignment.role_node_id.in_(ids)))
            await s.execute(delete(RoleNode).where(RoleNode.id.in_(ids)))
        for d in out["departments"]:
            depts[d["name"]].head_role_id = roles.get(d["head_ref"])
        await s.flush()
        await s.execute(select(func.rebuild_role_closure(tenant_id)))
    return {
        "departments": len(out["departments"]),
        "roles": {k: str(v) for k, v in roles.items()},
        "removed": len(removed),
    }


# ---------------------------------------------------------------------------------------------
# 4. Metrics: dry-run each feedable template, then the advisor
# ---------------------------------------------------------------------------------------------


async def _feedable_templates(
    tenant_id: uuid.UUID,
) -> tuple[list[SqlTemplate | CustomTemplate], dict[str, Any]]:
    async with tenant_tx("service", tenant_id) as s:
        maps = await repo.mappings(s)
        latest = (
            select(SqlTemplate.key, func.max(SqlTemplate.version).label("v"))
            .group_by(SqlTemplate.key)
            .subquery()
        )
        templates = (
            await s.scalars(
                select(SqlTemplate).join(
                    latest, (SqlTemplate.key == latest.c.key) & (SqlTemplate.version == latest.c.v)
                )
            )
        ).all()
        own = (
            await s.scalars(select(CustomTemplate).where(CustomTemplate.status == "approved"))
        ).all()
    newest: dict[str, CustomTemplate] = {}
    for c in own:  # only the newest approved version of a custom metric is offered
        if c.key not in newest or c.version > newest[c.key].version:
            newest[c.key] = c
    pool: list[SqlTemplate | CustomTemplate] = [*templates, *newest.values()]
    usable = [t for t in pool if set(t.aliases.values()) <= set(maps)]
    return usable, maps


def _refs(roles: list[RoleNode]) -> dict[str, RoleNode]:
    out: dict[str, RoleNode] = {}
    for r in sorted(roles, key=lambda r: (r.title, str(r.id))):
        base = re.sub(r"[^a-z0-9]+", "_", r.title.lower()).strip("_") or "role"
        ref, n = base, 2
        while ref in out:
            ref, n = f"{base}_{n}", n + 1
        out[ref] = r
    return out


async def start_metrics(
    actor: str, tenant_id: uuid.UUID, notes: str, warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    conn = await _connection(tenant_id)
    discovery = await _latest(tenant_id, "discovery", approved=True)
    wh = warehouse or _warehouse()
    templates, maps = await _feedable_templates(tenant_id)
    if not templates:
        raise Conflict("no template can run on the approved mappings")
    async with tenant_tx("service", tenant_id) as s:
        roles = (await s.scalars(select(RoleNode))).all()
        tenant = await s.get(Tenant, tenant_id)
        depts = {d.id: d for d in await s.scalars(select(Department))}
    if not roles:
        raise Conflict("approve the org web first")
    assert tenant is not None
    refs = _refs(list(roles))

    async def work(step_id: uuid.UUID) -> None:
        rules = await _rules(tenant_id)
        period_end = run_rules.period_end(datetime.now(UTC), "weekly")
        shapes, latest_values = {}, {}
        saved_runs: dict[str, Any] = {}
        if lab():
            for prev in await _lab_prior(tenant_id, "metrics"):
                for k, v in ((prev.checks or {}).get("dry_runs") or {}).items():
                    if isinstance(v, dict) and "error" not in v:
                        saved_runs.setdefault(k, v)
        for t in templates:
            if lab():  # replay what a real run saw; thresholds stay trend-only without values
                shapes[t.key] = saved_runs.get(
                    t.key, {"error": "not run: the lab has no warehouse"}
                )
                continue
            params = {**{k: v.get("default") for k, v in t.params_schema.items()},
                      "period_end": period_end, "row_cap": PROFILE_CAP}  # fmt: skip
            try:
                sql = render(t.sql, t.aliases, maps)
                check_contract(sql)
                result = await wh.query(conn, sql, params, f"formada:onboarding:dry:{t.key}",
                                        rules.query_timeout_seconds, PROFILE_CAP)  # fmt: skip
            except Exception as exc:
                shapes[t.key] = {"error": str(exc)[:300]}
                continue
            shape = ob.dry_run_shape(result.rows, result.truncated, PROFILE_CAP)
            shape["rows_needed_vs_workspace_cap"] = {
                "rows": len(result.rows), "row_cap": rules.query_row_cap,
                "fits": len(result.rows) <= rules.query_row_cap,
            }  # fmt: skip
            shapes[t.key] = shape
            last: dict[str, float] = {}
            for r in result.rows:
                last[str(r["entity"])] = float(r["value"] or 0)
            latest_values[t.key] = list(last.values())
        payload = {
            "today": date.today().isoformat(),
            "currency": tenant.currency,
            "templates": [
                {"template": t.key, "version": t.version, "playbook": t.playbook,
                 "description": t.description, "params": t.params_schema,
                 "driver": {k: v.get("exposure") for k, v in t.drivers.items()},
                 "dry_run": shapes.get(t.key)}
                for t in templates
            ],
            "roles": [
                {"ref": ref, "title": r.title, "archetype": r.role_archetype_key,
                 "department": depts[r.department_id].name if r.department_id in depts else None,
                 "decisions_owned": list(r.decisions_owned), "kpi_notes": r.kpi_notes}
                for ref, r in refs.items()
            ],
            "data_guide": {
                k: (discovery.output or {}).get(k) for k in ("summary", "cadence", "quality_issues")
            },
            "team_notes": notes,
        }  # fmt: skip
        out = await _ask(
            tenant_id, step_id, "metrics", payload, MetricsOut, MetricsOut(metrics=[], skipped=[])
        )
        if out is None:
            return
        data = out.model_dump()
        infos = {
            t.key: ob.TemplateInfo(
                t.key,
                t.version,
                frozenset(t.aliases.values()),
                t.params_schema,
                next((d.get("exposure") for d in t.drivers.values()), None),
            )
            for t in templates
        }
        report = ob.check_metrics(data, infos, set(maps), set(refs))
        repaired: dict[str, Any] | None = None
        if report.errors:  # one repair try: show the agent what the checks refused
            again = await _ask(
                tenant_id, step_id, "metrics",
                {**payload, "repair": {"your_answer": data, "errors": report.errors},
                 "note": "The checks refused your plan. Return the whole corrected plan."},
                MetricsOut, MetricsOut(metrics=[], skipped=[]), retry=True,
            )  # fmt: skip
            if again is not None:
                data2 = again.model_dump()
                report2 = ob.check_metrics(data2, infos, set(maps), set(refs))
                if len(report2.errors) < len(report.errors):
                    repaired = {"errors": report.errors}
                    data, report = data2, report2
        for m in data["metrics"]:  # code turns threshold rules into numbers
            m["template_version"] = (
                infos[m["template"]].version if m["template"] in infos else m["template_version"]
            )
            for a in m["attach"]:
                rule = a["threshold"]
                a["threshold_value"] = ob.threshold_from_rule(
                    rule["kind"], rule["value"], latest_values.get(m["template"], [])
                )
                today = latest_values.get(m["template"], [])
                a["would_fire"] = ob.would_fire(a["threshold_value"], m["higher_is_better"], today)
                if rule["kind"] != "none" and a["threshold_value"] is None:
                    report.warnings.append(
                        f"{m['key']} for {a['role_ref']}: the {rule['kind']} rule gives no "
                        "threshold on this data (values are mostly zero); it will be trend only"
                    )
        checks = {**report.as_dict(), "dry_runs": shapes}
        if repaired:
            checks["repaired_from"] = repaired
        await _finish(tenant_id, step_id, data, checks)

    return await _start(actor, tenant_id, "metrics", notes, work)


async def _apply_metrics(
    tenant_id: uuid.UUID, out: dict[str, Any], keys: set[str] | None
) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        refs = _refs(list((await s.scalars(select(RoleNode))).all()))
        existing = {m.key: m for m in await s.scalars(select(Metric))}
        created = []
        for m in out["metrics"]:
            if keys is not None and m["key"] not in keys:
                continue
            fields = dict(
                name=m["name"][:200],
                sql_template_key=m["template"], sql_template_version=m["template_version"],
                params={p["name"]: p["value"] for p in m.get("params", [])},
                unit=m["unit"][:30], higher_is_better=m["higher_is_better"],
                unit_value=Decimal(str(m["unit_value"])), is_active=True,
            )  # fmt: skip
            if m["key"] in existing:  # reopened step: update in place, re-attach its roles
                metric = existing[m["key"]]
                for k, v in fields.items():
                    setattr(metric, k, v)
                await s.execute(delete(RoleMetric).where(RoleMetric.metric_id == metric.id))
            else:
                metric = Metric(tenant_id=tenant_id, key=m["key"], **fields)
                s.add(metric)
            await s.flush()
            for a in m["attach"]:
                role = refs[a["role_ref"]]
                t = a.get("threshold_value")
                s.add(RoleMetric(
                    tenant_id=tenant_id, role_node_id=role.id, metric_id=metric.id,
                    weight=Decimal(str(a["weight"])),
                    threshold=Decimal(str(t)) if t is not None else None,
                    daily_check=a["daily_check"],
                ))  # fmt: skip
            created.append(m["key"])
        if keys is None:  # metrics the updated plan no longer has stop running
            for key, metric in existing.items():
                if key not in created:
                    metric.is_active = False
    return {"metrics": created}


# ---------------------------------------------------------------------------------------------
# 5. Business rules
# ---------------------------------------------------------------------------------------------


async def start_rules(actor: str, tenant_id: uuid.UUID, notes: str) -> dict[str, Any]:
    discovery = await _latest(tenant_id, "discovery", approved=True)
    metrics_step = await _latest(tenant_id, "metrics", approved=True)

    async def work(step_id: uuid.UUID) -> None:
        rules = await _rules(tenant_id)
        settings = [
            {"key": k, "value": getattr(rules, k), "minimum": v.minimum, "maximum": v.maximum,
             "unit": v.unit, "group": v.group, "meaning": v.help}
            for k, v in SCHEMA.items()
            if v.group != "access" and k != "llm_log_retention_days"
        ]  # fmt: skip
        profile = discovery.input.get("profile", {})
        tp = profile.get("time_profile") or {}
        payload = {
            "settings": settings,
            "data_shape": {
                "cadence": tp.get("cadence"),
                "row_breaks": tp.get("row_breaks"),
                "columns_filled_late": tp.get("columns_filled_late"),
                "quality_issues": (discovery.output or {}).get("quality_issues", []),
            },
            "metric_plan": [
                {"key": m["key"], "template": m["template"],
                 "higher_is_better": m["higher_is_better"],
                 "owners": [a["role_ref"] for a in m["attach"]],
                 "dry_run": (metrics_step.checks or {}).get("dry_runs", {}).get(m["template"])}
                for m in (metrics_step.output or {}).get("metrics", [])
            ],
            "team_notes": notes,
        }  # fmt: skip
        out = await _ask(
            tenant_id, step_id, "rules", payload, RulesOut, RulesOut(changes=[], kept=[], risks=[])
        )
        if out is None:
            return
        data = out.model_dump()
        report, clean = ob.check_rules(data)
        for c in data["changes"]:
            c["current"] = getattr(rules, c["key"], None)
            c["clean_value"] = clean.get(c["key"])
        unchanged = [c["key"] for c in data["changes"] if c["clean_value"] == c["current"]]
        if unchanged:  # the model sometimes "changes" a value to what it already is
            data["changes"] = [c for c in data["changes"] if c["key"] not in unchanged]
            report.warnings.append(f"dropped no-op changes: {', '.join(unchanged)}")
        await _finish(tenant_id, step_id, data, report.as_dict())

    return await _start(actor, tenant_id, "rules", notes, work)


# ---------------------------------------------------------------------------------------------
# Approve
# ---------------------------------------------------------------------------------------------


async def approve(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, keys: list[str] | None,
    reason: str = "",
) -> dict[str, Any]:  # fmt: skip
    async with tenant_tx("service", tenant_id) as s:
        row = await s.get(OnboardingStep, step_id)
    if row is None:
        raise NotFound("proposal")
    if row.status != "proposed" or not row.output:
        raise Conflict(f"only an open proposal can be approved (this one is {row.status})")
    await onboarding_collab.require_team_can_approve(tenant_id, row.step)
    await onboarding_review.guard_approve(actor, tenant_id, row.step, reason)
    selected = set(keys) if keys is not None else None
    applied: dict[str, Any]
    if row.step == "discovery":
        applied = {"data_guide": True}
    elif row.step == "mapping":
        applied = await _apply_mapping(tenant_id, row, selected)
        await _refresh_coverage(tenant_id, row, set(applied.get("archetypes", [])))
    elif row.step == "org":
        if not (row.checks or {}).get("ok", False):
            raise Conflict("the org proposal has errors; propose again")
        applied = await _apply_org(tenant_id, row.output)
        if (row.checks or {}).get("from_client_draft"):
            await onboarding_collab.mark_draft_approved(tenant_id)
    elif row.step == "metrics":
        if not (row.checks or {}).get("ok", False):
            raise Conflict("the metric plan has errors; propose again")
        applied = await _apply_metrics(tenant_id, row.output, selected)
    else:
        applied = await _apply_rules(actor, tenant_id, row, selected)
    async with tenant_tx("service", tenant_id) as s:
        r = await s.get(OnboardingStep, step_id)
        assert r is not None
        r.status, r.approved_by, r.approved_at, r.applied = (
            "approved", actor, datetime.now(UTC), applied,
        )  # fmt: skip
    await console._log(actor, "workspace", f"onboarding.{row.step}", None, applied, tenant_id)
    await onboarding_collab.sign_team(
        actor, tenant_id, row.step, await _summary(tenant_id, row, applied)
    )
    return {"status": "ok", "applied": applied}


async def _refresh_coverage(
    tenant_id: uuid.UUID, mapping: OnboardingStep, approved: set[str]
) -> None:
    """After mapping is approved, correct the data guide's coverage with what was measured."""
    measured = (mapping.checks or {}).get("archetypes") or {}
    async with tenant_tx("service", tenant_id) as s:
        row = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == "discovery", OnboardingStep.status == "approved")
            .order_by(OnboardingStep.created_at.desc())
            .limit(1)
        )
        if row is None or not row.output:
            return
        row.output = {
            **row.output,
            "coverage": ob.refresh_coverage(row.output.get("coverage", []), measured, approved),
            "measured_after_mapping": [
                {
                    "shape": n,
                    "rows": measured[n]["rows"],
                    "first_date": measured[n].get("first_date"),
                    "last_date": measured[n].get("last_date"),
                }
                for n in sorted(approved)
                if (measured.get(n) or {}).get("rows")
            ],
        }


async def _summary(
    tenant_id: uuid.UUID, row: OnboardingStep, applied: dict[str, Any]
) -> dict[str, Any]:
    """The client-safe account of an approved step (ADR 0027)."""
    out = row.output or {}
    if row.step == "discovery":
        return flow.summary_discovery(out, (row.input or {}).get("profile"))
    if row.step == "mapping":
        return flow.summary_mapping(
            out,
            (row.checks or {}).get("archetypes", {}),
            applied["archetypes"],
            await _location_names(tenant_id, out, applied["archetypes"]),
        )
    if row.step == "org":
        draft = await onboarding_collab.approved_draft_nodes(tenant_id)
        return flow.summary_org(out, draft if (row.checks or {}).get("from_client_draft") else None)
    if row.step == "metrics":
        async with tenant_tx("service", tenant_id) as s:
            roles = list((await s.scalars(select(RoleNode))).all())
            tenant = await s.get(Tenant, tenant_id)
        titles = {ref: r.title for ref, r in _refs(roles).items()}
        return flow.summary_metrics(out, titles, tenant.currency if tenant else "CAD")
    labels = {k: (v.label, v.unit) for k, v in SCHEMA.items()}
    applied_keys = set(applied.get("rules", {}))
    changes = [c for c in out.get("changes", []) if c["key"] in applied_keys]
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
    return flow.summary_rules(
        changes, labels, await _rules(tenant_id), tenant.currency if tenant else "CAD"
    )


async def _location_names(
    tenant_id: uuid.UUID, out: dict[str, Any], written: list[str]
) -> dict[str, list[str]]:
    """Location kind -> the client's location names, from the approved link (best effort)."""
    link = next(
        (a for a in out.get("archetypes", [])
         if a["archetype"] in written
         and {"location_kind", "location_name"} <= {f["field"] for f in a.get("fields", [])}),
        None,
    )  # fmt: skip
    if link is None:
        return {}
    try:
        conn = await _connection(tenant_id)
        sql = ob.kind_names_sql(link["source_sql"])
        rows = await _q(_warehouse(), conn, sql, "map:names", 400)
    except Exception as exc:  # the summary must not fail on a warehouse hiccup
        log.warning("onboarding.location_names_failed", error=str(exc)[:200])
        return {}
    names: dict[str, list[str]] = {}
    for r in rows:
        names.setdefault(str(r.get("kind") or "other"), []).append(str(r.get("name") or ""))
    return names


async def refresh_summaries(actor: str, tenant_id: uuid.UUID) -> dict[str, Any]:
    """Rebuild the client summaries of approved steps (new wording, new facts). Keeps approvals."""
    refreshed = []
    for step in ("discovery", "mapping", "org", "metrics", "rules"):
        try:
            row = await _latest(tenant_id, step, approved=True)
        except (NotFound, Conflict):
            continue
        summary = await _summary(tenant_id, row, row.applied or {})
        if await onboarding_collab.set_summary(tenant_id, step, summary):
            refreshed.append(step)
    if await onboarding_collab.set_trial_summary(tenant_id):
        refreshed.append("trial")
    log.info("onboarding.summaries_refreshed", actor=actor, steps=refreshed)
    return {"status": "ok", "refreshed": refreshed}


async def _apply_mapping(
    tenant_id: uuid.UUID, row: OnboardingStep, selected: set[str] | None
) -> dict[str, Any]:
    checks = (row.checks or {}).get("archetypes", {})
    assert row.output is not None
    written, skipped = [], []
    async with tenant_tx("service", tenant_id) as s:
        for p in row.output["archetypes"]:
            name = p["archetype"]
            if p["status"] == "unmappable" or (selected is not None and name not in selected):
                continue
            check = checks.get(name, {})
            if not check.get("ok"):
                if selected is None:  # approving the proposal: keep what passed, skip the rest
                    skipped.append(name)
                    continue
                raise Conflict(f"{name} has failing checks: {check.get('errors', [])[:2]}")
            fields = [f["field"] for f in p["fields"]]
            current = await s.scalar(
                select(ArchetypeMapping).where(ArchetypeMapping.archetype_key == name)
            )
            if current is None:
                current = ArchetypeMapping(tenant_id=tenant_id, archetype_key=name)
                s.add(current)
            current.source = p["source_sql"].strip().rstrip(";")
            current.columns = {f: f for f in fields}
            written.append(name)
    if not written:
        raise Conflict("nothing to approve: no mapping passes its checks")
    return {"archetypes": written, "skipped_failing": skipped}


async def _apply_rules(
    actor: str, tenant_id: uuid.UUID, row: OnboardingStep, selected: set[str] | None
) -> dict[str, Any]:
    applied = {}
    assert row.output is not None
    for c in row.output.get("changes", []):
        if c.get("clean_value") is None or (selected is not None and c["key"] not in selected):
            continue
        await console.set_workspace(actor, tenant_id, c["key"], c["clean_value"])
        applied[c["key"]] = c["clean_value"]
    return {"rules": applied}


async def agent_models() -> dict[str, str | None]:
    async with global_tx("service") as s:
        rows = (await s.scalars(select(Agent).where(Agent.kind == "onboarding"))).all()
    return {a.key: a.model_override for a in rows}


# ---------------------------------------------------------------------------------------------
# Team edits to a proposal (ADR 0027): a new proposal, checked again, approved as usual
# ---------------------------------------------------------------------------------------------


async def _edited_copy(
    actor: str, tenant_id: uuid.UUID, base: OnboardingStep, output: dict[str, Any],
    checks: dict[str, Any],
) -> dict[str, Any]:  # fmt: skip
    async with tenant_tx("service", tenant_id) as s:
        row = OnboardingStep(
            tenant_id=tenant_id, step=base.step, status="running", created_by=actor,
            notes=f"edited by our team from proposal {base.id}", input=base.input,
            agent_key=base.agent_key, agent_version=base.agent_version,
            provider=base.provider, model=base.model,
        )  # fmt: skip
        s.add(row)
        await s.flush()
        new_id = row.id
    await _finish(tenant_id, new_id, output, checks)
    return {"status": "ok", "step_id": str(new_id)}


async def _base(tenant_id: uuid.UUID, step_id: uuid.UUID, step: str) -> OnboardingStep:
    async with tenant_tx("service", tenant_id) as s:
        base = await s.get(OnboardingStep, step_id)
    if base is None or base.step != step or not base.output or base.output.get("raw"):
        raise NotFound(f"{step} proposal")
    return base


async def edit_metrics(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, edits: list[dict[str, Any]]
) -> dict[str, Any]:
    """Who watches what: include or drop a measure, and set its roles, weights, alert levels
    and daily checks. An alert level the team types is kept as a fixed number."""
    await onboarding_collab.require_team_can_work(tenant_id, "metrics")
    base = await _base(tenant_id, step_id, "metrics")
    templates, maps = await _feedable_templates(tenant_id)
    async with tenant_tx("service", tenant_id) as s:
        refs = _refs(list((await s.scalars(select(RoleNode))).all()))
    by_key = {e["key"]: e for e in edits}
    data = json.loads(json.dumps(base.output))
    kept, skipped = [], list(data.get("skipped", []))
    for m in data["metrics"]:
        e = by_key.get(m["key"])
        if e is None:
            kept.append(m)
            continue
        if not e.get("include", True):
            skipped.append({"template": m["template"], "reason": "removed by our team"})
            continue
        old = {a["role_ref"]: a for a in m["attach"]}
        attach = []
        for a in e.get("attach", []):
            ref, value = a["role_ref"], a.get("threshold_value")
            prev = old.get(ref, {})
            same = value is not None and value == prev.get("threshold_value")
            attach.append({
                "role_ref": ref,
                "weight": float(a.get("weight", prev.get("weight", 1.0))),
                "daily_check": bool(a.get("daily_check", prev.get("daily_check", False))),
                "why": prev.get("why") or "set by our team",
                "threshold": prev["threshold"] if same or (value is None and prev and
                             prev["threshold"]["kind"] == "none") else (
                    {"kind": "fixed", "value": float(value), "basis": "set by our team"}
                    if value is not None else
                    {"kind": "none", "value": 0, "basis": "trend only, set by our team"}),
                "threshold_value": float(value) if value is not None else None,
            })  # fmt: skip
        m["attach"] = attach
        kept.append(m)
    data["metrics"], data["skipped"] = kept, skipped
    # Lock only the measures whose content changed (the editor sends every row).
    before = {m["key"]: m for m in (base.output or {}).get("metrics", [])}
    changed = {m["key"] for m in kept if m != before.get(m["key"])}
    data["locked"] = sorted((set(data.get("locked", [])) | changed) & {m["key"] for m in kept})
    infos = {
        t.key: ob.TemplateInfo(t.key, t.version, frozenset(t.aliases.values()), t.params_schema)
        for t in templates
    }
    report = ob.check_metrics(data, infos, set(maps), set(refs))
    for m in data["metrics"]:
        for a in m["attach"]:
            if a["threshold"]["kind"] == "fixed" and a["threshold_value"] < 0:
                report.errors.append(f"{m['key']}: an alert level cannot be negative")
    checks = {**report.as_dict(), "dry_runs": (base.checks or {}).get("dry_runs", {}),
              "edited_by": actor}  # fmt: skip
    return await _edited_copy(actor, tenant_id, base, data, checks)


async def edit_rules(
    actor: str, tenant_id: uuid.UUID, step_id: uuid.UUID, changes: list[dict[str, Any]]
) -> dict[str, Any]:
    """The team sets the proposed rule changes: each value checked against its allowed range."""
    await onboarding_collab.require_team_can_work(tenant_id, "rules")
    base = await _base(tenant_id, step_id, "rules")
    current = await _rules(tenant_id)
    reasons = {c["key"]: c.get("reason", "") for c in (base.output or {}).get("changes", [])}
    out, warnings = [], []
    for c in changes:
        key = c["key"]
        if key not in SCHEMA:
            raise Invalid(f"unknown setting {key}")
        if key in ob.BLOCKED_RULE_KEYS:
            raise Invalid(f"{key} is not changed during onboarding")
        try:
            clean = coerce(key, c["value"])
        except ValueError as exc:
            raise Invalid(f"{SCHEMA[key].label}: {exc}") from exc
        if clean == getattr(current, key):
            warnings.append(f"{key}: same as the current value, left out")
            continue
        reason = c.get("reason") or reasons.get(key) or "set by our team"
        out.append(
            {"key": key, "value": c["value"], "clean_value": clean,
             "current": getattr(current, key), "reason": reason}
        )  # fmt: skip
    # Lock only the settings whose value is new or changed (the editor sends every row).
    before = {c["key"]: c.get("clean_value") for c in (base.output or {}).get("changes", [])}
    changed = {c["key"] for c in out if before.get(c["key"]) != c["clean_value"]}
    locked = (set((base.output or {}).get("locked", [])) | changed) & {c["key"] for c in out}
    data = {**(base.output or {}), "changes": out, "locked": sorted(locked)}
    checks = {"ok": True, "errors": [], "warnings": warnings, "edited_by": actor}
    return await _edited_copy(actor, tenant_id, base, data, checks)


async def guide(tenant_id: uuid.UUID) -> dict[str, Any]:
    """Reference for the console: the warehouse profile from discovery, our standard shapes and
    the role types, so each step can explain itself."""
    async with tenant_tx("service", tenant_id) as s:
        disc = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == "discovery", OnboardingStep.input.is_not(None))
            .order_by(OnboardingStep.created_at.desc())
            .limit(1)
        )
    profile = ((disc.input or {}).get("profile") or {}) if disc else {}
    # The links the team reviewed (removed, changed, added): what the mapper uses.
    profile = (
        dc.effective_profile(profile, dc.with_links(disc.output or {}, profile))
        if disc
        else profile
    )
    tables = [
        {"table": t["table"], "rows": t.get("rows"),
         "columns": [{k: c.get(k) for k in ("column", "type", "fill_pct", "distinct")}
                     for c in t.get("columns", [])]}
        for t in profile.get("tables", [])
    ]  # fmt: skip

    def _clip(v: Any, n: int = 200) -> str:
        return str(v or "")[:n]

    views = [
        {
            "view": v.get("view"),
            "comment": _clip(v.get("comment")),
            "tables": [
                {
                    "table": t.get("table"),
                    "base_table": t.get("base_table"),
                    "comment": _clip(t.get("comment")),
                    "measured": t.get("measured"),
                    "dimensions": [
                        {"name": d.get("name"), "type": d.get("type"),
                         "comment": _clip(d.get("comment"), 140)}
                        for d in t.get("dimensions", [])
                    ],
                    "metrics": [
                        {"name": m.get("name"), "expression": _clip(m.get("expression"), 240),
                         "comment": _clip(m.get("comment"), 160)}
                        for m in t.get("metrics", [])
                    ],
                }
                for t in v.get("tables", [])
            ],
            "relationships": v.get("relationships", []),
        }
        for v in profile.get("semantic_views", [])
    ]  # fmt: skip
    tp = profile.get("time_profile") or {}
    return {
        "profile": {"database": profile.get("database"), "tables": tables},
        "semantic_views": views,
        "time_profile": {
            "date_column": tp.get("date_column"),
            "entity_columns": tp.get("entity_columns", []),
            "cadence": (tp.get("cadence") or {}).get("runs", []),
            "breaks": tp.get("row_breaks", []),
            "filled_late": tp.get("columns_filled_late", []),
            "dates": [
                {"date": r.get("date"), "rows": r.get("rows")} for r in tp.get("by_date", [])
            ],
        },
        "categories": [
            {"column": c.get("column"), "values": c.get("values", [])[:12]}
            for c in profile.get("categories", [])
        ],
        "key_overlaps": profile.get("key_overlaps", []),
        # The joins code tested on the data: share of values that find a match.
        "tested_joins": profile.get("joins", [])[:60],
        "archetypes": await _archetypes(),
        "role_archetypes": await _role_archetypes(),
        "rule_settings": [
            {
                "key": k,
                "label": v.label,
                "help": v.help,
                "group": v.group,
                "minimum": v.minimum,
                "maximum": v.maximum,
                "unit": v.unit,
            }
            for k, v in SCHEMA.items()
            if k not in ob.BLOCKED_RULE_KEYS
        ],
    }
