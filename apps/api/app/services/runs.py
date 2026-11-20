"""Run lifecycle for n8n: due tenants, create (with the per-tenant lock), steps, finish, fail."""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select

from app.core.db import global_tx, tenant_tx
from app.core.logging import bind_request_context, get_logger
from app.domain import runs as run_rules
from app.models import Initiative, Person, RoleMetric, RoleNode, Run, Tenant
from app.repositories import org as org_repo
from app.repositories import runs as run_repo

log = get_logger(__name__)
DAILY_PLAN_STEP = "daily_plan"  # one per role a daily check decided to run


class RunNotRunning(Exception):
    """A step arrived for a run that already finished or failed; the router answers skipped."""


async def _due_roles(s: Any, run_type: str) -> list[Any]:
    """Role nodes a run of this type covers (weekly: every role with metrics; daily_check: roles
    with a daily_check metric or a daily cadence; other types work at tenant level)."""
    where: Any
    if run_type == "weekly":
        where = RoleNode.id.in_(select(RoleMetric.role_node_id))
    elif run_type == "daily_check":
        where = RoleNode.id.in_(
            select(RoleMetric.role_node_id).where(RoleMetric.daily_check.is_(True))
        ) | (RoleNode.cadence == "daily") & RoleNode.id.in_(select(RoleMetric.role_node_id))
    else:
        return []
    rows = await s.execute(
        select(RoleNode.id, RoleNode.title).where(where).order_by(RoleNode.title)
    )
    return list(rows.all())


async def _has_work(s: Any, run_type: str, roles: list[Any]) -> bool:
    if run_type in ("weekly", "daily_check"):
        return bool(roles)
    if run_type == "remeasure":
        return bool(await s.scalar(select(Initiative.id).where(Initiative.status == "in_progress")))
    return bool(await s.scalar(select(Person.id)))  # digest


async def due_tenants(run_type: str, now: datetime, force: bool) -> dict[str, Any]:
    """Tenants whose slot of this type has come (tenant time zone), with the role nodes to run.
    force=true returns every tenant with work, at the current slot (manual/dev runs)."""
    async with global_tx("service") as s:
        tenants = (await s.scalars(select(Tenant).order_by(Tenant.name))).all()
    due = []
    for t in tenants:
        async with tenant_tx("service", t.id) as s:
            if run_type == "digest":
                last = await run_repo.last_digest_slot(s)
            else:
                last = await run_repo.last_success_slot(s, run_type)
            slot = run_rules.due(run_type, now, t.timezone, last)
            if force:
                slot = slot or run_rules.current_slot(run_type, now, t.timezone)
                slot = slot or run_rules.daily_slot(now, t.timezone, run_rules.DAILY_CHECK_TIME)
            if slot is None:
                continue
            roles = await _due_roles(s, run_type)
            if not await _has_work(s, run_type, roles):
                continue  # nothing to run for this tenant
        due.append(
            {
                "tenant_id": str(t.id),
                "name": t.name,
                "slot": slot.isoformat(),
                "role_nodes": [{"id": str(r.id), "title": r.title} for r in roles],
            }
        )
    return {"status": "ok", "tenants": due}


async def all_tenants() -> dict[str, Any]:
    async with global_tx("service") as s:
        tenants = (await s.scalars(select(Tenant).order_by(Tenant.name))).all()
    return {"status": "ok", "tenants": [{"tenant_id": str(t.id), "name": t.name} for t in tenants]}


async def create_run(
    tenant_id: uuid.UUID, run_type: str, slot: datetime, execution_id: str | None
) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        await run_repo.lock_tenant(s, tenant_id)
        rules = await org_repo.rules(s)
        if await run_repo.running_count(s) >= rules.max_concurrent_runs_per_tenant:
            return {"status": "busy", "reason": "tenant run limit reached"}
        run = Run(
            tenant_id=tenant_id,
            type=run_type,
            status="running",
            scheduled_for=slot,
            period_end=run_rules.period_end(slot, run_type),
            started_at=datetime.now(UTC),
            n8n_execution_id=execution_id,
        )
        s.add(run)
        await s.flush()
    bind_request_context(tenant_id=str(tenant_id), run_id=str(run.id))
    log.info("run.created", type=run_type, slot=slot.isoformat())
    return {"status": "ok", "run_id": str(run.id), "period_end": run.period_end.isoformat()}


@asynccontextmanager
async def step(
    tenant_id: uuid.UUID, run_id: uuid.UUID, role_node_id: uuid.UUID | None, name: str
) -> AsyncIterator[dict[str, Any]]:
    """Record a step: running on entry, then the status the body puts in the yielded dict.
    An exception leaves it 'running' (n8n retries; after the last try it calls steps/fail)."""
    bind_request_context(tenant_id=str(tenant_id), run_id=str(run_id))
    async with tenant_tx("service", tenant_id) as s:
        if await run_repo.get_running(s, run_id) is None:
            raise RunNotRunning(run_id)
        await run_repo.start_step(s, tenant_id, run_id, role_node_id, name)
    outcome: dict[str, Any] = {"status": "ok"}
    yield outcome
    async with tenant_tx("service", tenant_id) as s:
        detail = {k: v for k, v in outcome.items() if k != "status"}
        await run_repo.finish_step(s, run_id, role_node_id, name, outcome["status"], detail)
    log.info("step.done", step=name, role_node_id=str(role_node_id), **outcome)


async def fail_step(
    tenant_id: uuid.UUID, run_id: uuid.UUID, role_node_id: uuid.UUID | None, name: str, error: str
) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        await run_repo.mark_step_failed(s, tenant_id, run_id, role_node_id, name, error[:2000])
    log.warning("step.failed", step=name, role_node_id=str(role_node_id), error=error[:300])
    return {"status": "ok", "marked": "failed"}


async def finish_run(tenant_id: uuid.UUID, run_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        run = await s.get(Run, run_id)
        if run is None:
            return {"status": "skipped", "reason": "unknown run"}
        if run.status != "running":
            return {"status": "skipped", "reason": f"run already {run.status}"}
        # A role that should have run but never recorded a step (e.g. the sub-workflow did not
        # start) is a failure, not a silent success. Weekly runs cover every role with metrics,
        # daily checks the roles their plan picked, and remeasure runs no role at all.
        if run.type == "weekly":
            expected = set(await s.scalars(select(RoleMetric.role_node_id).distinct()))
        elif run.type == "daily_check":
            expected = await run_repo.roles_with_steps(s, run_id, only=DAILY_PLAN_STEP)
        else:
            expected = set()
        missing = expected - await run_repo.roles_with_steps(s, run_id, exclude=DAILY_PLAN_STEP)
        for role_id in missing:
            await run_repo.mark_step_failed(
                s, tenant_id, run_id, role_id, "role_pipeline", "role never ran"
            )
        run.status = run_rules.run_status(await run_repo.step_statuses(s, run_id))
        run.ended_at = datetime.now(UTC)
        status = run.status
    log.info("run.finished", run_status=status, roles_missing=len(missing))
    return {"status": "ok", "run_status": status, "roles_missing": len(missing)}


async def fail_run(tenant_id: uuid.UUID, run_id: uuid.UUID, error: str) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        run = await s.get(Run, run_id)
        if run is None:
            return {"status": "skipped", "reason": "unknown run"}
        if run.status == "running":
            run.status = "failed"
            run.ended_at = datetime.now(UTC)
        run.error = error[:4000]
    log.error("run.failed", error=error[:300])
    return {"status": "ok", "run_status": "failed"}


async def fail_by_execution(execution_id: str, error: str) -> dict[str, Any]:
    """For the n8n error workflow, which knows only the failed execution id."""
    async with global_tx("service") as s:
        tenant_ids = list(await s.scalars(select(Tenant.id)))
    failed = []
    for tenant_id in tenant_ids:
        async with tenant_tx("service", tenant_id) as s:
            runs = await s.scalars(
                select(Run).where(Run.n8n_execution_id == execution_id, Run.status == "running")
            )
            for run in runs:
                run.status, run.ended_at, run.error = "failed", datetime.now(UTC), error[:4000]
                failed.append(str(run.id))
    log.error("run.failed_by_execution", execution_id=execution_id, runs=failed, error=error[:300])
    return {"status": "ok" if failed else "skipped", "runs": failed}
