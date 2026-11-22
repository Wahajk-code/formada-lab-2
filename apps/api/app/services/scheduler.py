"""The in-app scheduler (ADR 0034), the only thing n8n did.

A loop wakes every few seconds, looks at the flows' schedules and starts the ones whose slot has
come. Each flow then asks the API's own services which workspaces are due (each workspace's own
time zone decides that), so the clock here is only a tick.

Safe to run twice (two API instances, a restart in the middle of a slot): every step goes through
the idempotency store with the same keys n8n used, so the second start of a slot writes nothing.

A flow can be paused from the console. The switch is a `system_config` row, `flow.<key>.paused`
(the rules code ignores keys it does not know). A paused flow skips its scheduled starts; a manual
"run now" still works.
"""

import asyncio
import contextlib
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert

from app.core.db import global_tx, tenant_tx
from app.core.logging import get_logger
from app.core.settings import get_settings
from app.domain import flows as fl
from app.models import Run, SystemConfig, Tenant
from app.services import flows as runner

log = get_logger(__name__)
PREFIX = "flow."
LAB_NO_RUNS = (
    "Runs are off in the review lab: it has no scheduler and makes no cards. "
    "They run on a live workspace."
)
_fired: dict[str, datetime] = {}  # the last slot started, per flow (this process)


def _key(flow_key: str) -> str:
    return f"{PREFIX}{flow_key}.paused"


async def paused_flows() -> set[str]:
    async with global_tx("service") as s:
        rows = await s.execute(
            select(SystemConfig.key, SystemConfig.value).where(SystemConfig.key.like(f"{PREFIX}%"))
        )
    return {r.key[len(PREFIX) : -len(".paused")] for r in rows if r.value is True}


async def set_paused(actor: str, flow_key: str, paused: bool) -> dict[str, Any]:
    if flow_key not in fl.FLOWS:
        raise KeyError(flow_key)
    stmt = insert(SystemConfig).values(key=_key(flow_key), value=paused, updated_by=actor)
    async with global_tx("service") as s:
        await s.execute(
            stmt.on_conflict_do_update(
                index_elements=["key"],
                set_={"value": paused, "updated_by": actor, "updated_at": datetime.now(UTC)},
            )
        )
    log.info("flow.paused" if paused else "flow.resumed", flow=flow_key, actor=actor)
    return {"status": "ok", "flow": flow_key, "paused": paused}


async def tick(now: datetime | None = None, *, paused: set[str] | None = None) -> list[str]:
    """Start every flow whose slot has come. Returns the flows started."""
    now = now or datetime.now(UTC)
    off = await paused_flows() if paused is None else paused
    started: list[str] = []
    for flow in fl.FLOWS.values():
        slot = fl.slot_to_fire(flow, now, _fired.get(flow.key))
        if slot is None:
            continue
        _fired[flow.key] = slot  # claimed: a slow start is not started again by the next tick
        if flow.key in off:
            runner.HISTORY[flow.key].appendleft(
                fl.Execution(
                    flow.key, "scheduled", now, now, "skipped", note="paused in the console"
                )
            )
            continue
        runner.launch(flow.key, trigger="scheduled", now=now)
        started.append(flow.key)
    return started


async def loop(stop: asyncio.Event) -> None:
    """Run until `stop` is set. A tick that fails is logged and the loop carries on."""
    every = max(5, get_settings().scheduler_tick_seconds)
    log.info("scheduler.started", flows=list(fl.FLOWS), every_s=every)
    while not stop.is_set():
        try:
            await tick()
        except Exception:
            log.exception("scheduler.tick_failed")
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(stop.wait(), every)
    log.info("scheduler.stopped")


# ---- manual starts ------------------------------------------------------------------------------


def run_now(tenant_id: uuid.UUID) -> None:
    """A manual weekly run for one workspace (Run now)."""
    runner.launch("weekly", trigger="manual", tenant_id=tenant_id)


def on_feedback(tenant_id: uuid.UUID, feedback_id: uuid.UUID) -> None:
    """Someone gave feedback: compile it into proposed rules now rather than tonight."""
    if get_settings().scheduler_enabled:
        runner.launch("feedback", trigger="feedback", tenant_id=tenant_id, feedback_id=feedback_id)


# ---- what the dashboard shows -------------------------------------------------------------------


def _step_view(s: fl.Step) -> dict[str, Any]:
    return {
        "key": s.key, "label": s.label, "does": s.does, "scope": s.scope, "reads": list(s.reads),
        "writes": list(s.writes), "ai": s.ai, "on_error": s.on_error, "failure": s.failure,
        "skips": s.skips, "timeout_s": s.timeout_s,
    }  # fmt: skip


def _execution_view(e: fl.Execution) -> dict[str, Any]:
    return {
        "trigger": e.trigger, "status": e.status, "started_at": e.started_at.isoformat(),
        "ended_at": e.ended_at.isoformat() if e.ended_at else None, "workspaces": e.workspaces,
        "note": e.note,
    }  # fmt: skip


def _run_view(r: Run, workspace: Tenant) -> dict[str, Any]:
    return {
        "run_id": str(r.id),
        "workspace": workspace.name,
        "workspace_id": str(workspace.id),
        "status": r.status,
        "started_at": r.started_at.isoformat(),
        "ended_at": r.ended_at.isoformat() if r.ended_at else None,
        "error": r.error,
    }


async def recent_runs(run_type: str, limit: int = 6) -> list[dict[str, Any]]:
    """The latest runs of a type across workspaces (they are in the database, with their steps)."""
    async with global_tx("service") as s:
        tenants = (await s.scalars(select(Tenant).order_by(Tenant.name))).all()
    found: list[tuple[datetime, dict[str, Any]]] = []
    for t in tenants:
        async with tenant_tx("service", t.id) as s:
            rows = await s.scalars(
                select(Run).where(Run.type == run_type).order_by(Run.started_at.desc()).limit(limit)
            )
            found.extend((r.started_at, _run_view(r, t)) for r in rows)
    return [view for _, view in sorted(found, key=lambda x: x[0], reverse=True)[:limit]]


async def _flow_view(flow: fl.Flow, now: datetime, off: set[str]) -> dict[str, Any]:
    reads, writes = fl.tables_of(flow)
    sched = flow.schedule
    return {
        "key": flow.key,
        "name": flow.name,
        "purpose": flow.purpose,
        "run_type": flow.run_type,
        "schedule": sched.describe() if sched else None,
        "schedule_note": sched.note if sched else "",
        "also": flow.also,
        "paused": flow.key in off,
        "next_at": fl.next_slot(sched, now).isoformat() if sched else None,
        "steps": [_step_view(s) for s in flow.steps],
        "reads": list(reads),
        "writes": list(writes),
        "history": [_execution_view(e) for e in runner.HISTORY[flow.key]][:8],
        "runs": await recent_runs(flow.run_type) if flow.run_type else [],
    }


async def overview() -> dict[str, Any]:
    """Every flow with its steps, tables, schedule, pause state, last starts and latest runs."""
    now = datetime.now(UTC)
    off = await paused_flows()
    settings = get_settings()
    return {
        "enabled": settings.scheduler_enabled and not settings.lab_mode,
        "lab": settings.lab_mode,
        "tries": fl.TRIES,
        "wait_s": fl.WAIT_S,
        "max_runs_per_workspace": fl.MAX_RUNS_PER_TENANT,
        "now": now.isoformat(),
        "flows": [await _flow_view(f, now, off) for f in fl.FLOWS.values()],
    }
