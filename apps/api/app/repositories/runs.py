import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditLog, Run, RunStep

STALE_AFTER = timedelta(hours=6)


async def lock_tenant(session: AsyncSession, tenant_id: uuid.UUID) -> None:
    """Serialize run creation per tenant for the rest of the transaction."""
    await session.execute(
        text("select pg_advisory_xact_lock(hashtextextended(:k, 0))"), {"k": f"run:{tenant_id}"}
    )


async def running_count(session: AsyncSession) -> int:
    since = datetime.now(UTC) - STALE_AFTER
    count = await session.scalar(
        select(func.count()).where(Run.status == "running", Run.started_at > since)
    )
    return int(count or 0)


async def last_success_slot(session: AsyncSession, run_type: str) -> datetime | None:
    result: datetime | None = await session.scalar(
        select(func.max(Run.scheduled_for)).where(
            Run.type == run_type, Run.status.in_(("succeeded", "partial"))
        )
    )
    return result


async def get_running(session: AsyncSession, run_id: uuid.UUID) -> Run | None:
    run = await session.get(Run, run_id)
    return run if run is not None and run.status == "running" else None


async def start_step(
    session: AsyncSession,
    tenant_id: uuid.UUID,
    run_id: uuid.UUID,
    role_node_id: uuid.UUID | None,
    step: str,
) -> None:
    """Upsert the step as running; every retry increments attempts."""
    stmt = insert(RunStep).values(
        tenant_id=tenant_id,
        run_id=run_id,
        role_node_id=role_node_id,
        step=step,
        status="running",
        attempts=1,
        detail={},
    )
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["run_id", "role_node_id", "step"],
            set_={"status": "running", "attempts": RunStep.attempts + 1, "finished_at": None},
        )
    )


async def finish_step(
    session: AsyncSession,
    run_id: uuid.UUID,
    role_node_id: uuid.UUID | None,
    step: str,
    status: str,
    detail: dict[str, Any],
) -> None:
    role_match = (
        RunStep.role_node_id.is_(None)
        if role_node_id is None
        else RunStep.role_node_id == role_node_id
    )
    row = await session.scalar(
        select(RunStep).where(RunStep.run_id == run_id, RunStep.step == step, role_match)
    )
    if row is None:
        return
    row.status = status
    row.detail = detail
    row.finished_at = datetime.now(UTC)


async def step_statuses(session: AsyncSession, run_id: uuid.UUID) -> list[str]:
    return list(await session.scalars(select(RunStep.status).where(RunStep.run_id == run_id)))


async def roles_with_steps(
    session: AsyncSession,
    run_id: uuid.UUID,
    only: str | None = None,
    exclude: str | None = None,
) -> set[uuid.UUID]:
    stmt = select(RunStep.role_node_id).where(
        RunStep.run_id == run_id, RunStep.role_node_id.is_not(None)
    )
    if only:
        stmt = stmt.where(RunStep.step == only)
    if exclude:
        stmt = stmt.where(RunStep.step != exclude)
    return {r for r in await session.scalars(stmt) if r is not None}


async def last_digest_slot(session: AsyncSession) -> datetime | None:
    """Digests are not runs: each send writes an audit row with its slot."""
    value = await session.scalar(
        select(func.max(AuditLog.detail["slot"].astext)).where(AuditLog.action == "digest.sent")
    )
    return datetime.fromisoformat(value) if value else None


async def mark_step_failed(
    session: AsyncSession,
    tenant_id: uuid.UUID,
    run_id: uuid.UUID,
    role_node_id: uuid.UUID | None,
    step: str,
    error: str,
) -> None:
    """Final state after the scheduler gave up; keeps the attempts the API actually saw."""
    stmt = insert(RunStep).values(
        tenant_id=tenant_id,
        run_id=run_id,
        role_node_id=role_node_id,
        step=step,
        status="failed",
        attempts=0,
        detail={"error": error},
        finished_at=datetime.now(UTC),
    )
    await session.execute(
        stmt.on_conflict_do_update(
            index_elements=["run_id", "role_node_id", "step"],
            set_={"status": "failed", "detail": {"error": error}, "finished_at": datetime.now(UTC)},
        )
    )
