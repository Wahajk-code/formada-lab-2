"""Queries for the run pipeline. Sessions are tenant-scoped by the caller (RLS)."""

import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta

from sqlalchemy import and_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.filtering import RoleFeedbackState
from app.domain.templates import Mapping
from app.integrations.warehouse import ConnectionConfig
from app.models import (
    ArchetypeMapping,
    CustomTemplate,
    Department,
    Feedback,
    FeedbackRule,
    InsightCard,
    LlmCallLog,
    Metric,
    MetricSnapshot,
    PromptTemplate,
    RoleMetric,
    RoleNode,
    Signal,
    SqlTemplate,
    WarehouseConnection,
)


async def connection(session: AsyncSession) -> ConnectionConfig | None:
    wc = await session.scalar(select(WarehouseConnection))
    if wc is None:
        return None
    return ConnectionConfig(
        account=wc.account_identifier,
        user=wc.user_name,
        role=wc.role_name,
        warehouse=wc.warehouse_name,
        database=wc.database_name,
        secret_ref=wc.secret_ref,
    )


async def mappings(session: AsyncSession) -> dict[str, Mapping]:
    rows = await session.scalars(select(ArchetypeMapping))
    return {m.archetype_key: Mapping(m.source, m.columns) for m in rows}


async def metrics_for_run(session: AsyncSession, daily_only: bool) -> Sequence[Metric]:
    """Active metrics attached to at least one role. Daily runs: daily_check metrics, plus every
    metric of a daily-cadence role (spec: only daily_check metrics run on the other days)."""
    attached = select(RoleMetric.metric_id)
    if daily_only:
        daily_roles = select(RoleNode.id).where(RoleNode.cadence == "daily")
        attached = attached.where(
            RoleMetric.daily_check.is_(True) | RoleMetric.role_node_id.in_(daily_roles)
        )
    rows = await session.scalars(
        select(Metric)
        .where(Metric.is_active.is_(True), Metric.id.in_(attached))
        .order_by(Metric.key)
    )
    return rows.all()


async def template(
    session: AsyncSession, key: str, version: int
) -> SqlTemplate | CustomTemplate | None:
    """A catalog template, or this workspace's own (approved) custom one."""
    found: SqlTemplate | CustomTemplate | None = await session.scalar(
        select(SqlTemplate).where(SqlTemplate.key == key, SqlTemplate.version == version)
    )
    if found is None:
        found = await session.scalar(
            select(CustomTemplate).where(
                CustomTemplate.key == key,
                CustomTemplate.version == version,
                CustomTemplate.status == "approved",
            )
        )
    return found


async def role_metrics(
    session: AsyncSession, role_node_id: uuid.UUID
) -> Sequence[tuple[RoleMetric, Metric]]:
    rows = await session.execute(
        select(RoleMetric, Metric)
        .join(Metric, Metric.id == RoleMetric.metric_id)
        .where(RoleMetric.role_node_id == role_node_id, Metric.is_active.is_(True))
    )
    return [(rm, m) for rm, m in rows.tuples()]


async def snapshot(
    session: AsyncSession, run_id: uuid.UUID, metric_id: uuid.UUID
) -> MetricSnapshot | None:
    result: MetricSnapshot | None = await session.scalar(
        select(MetricSnapshot).where(
            MetricSnapshot.run_id == run_id, MetricSnapshot.metric_id == metric_id
        )
    )
    return result


async def feedback_state(
    session: AsyncSession, role_node_id: uuid.UUID, suppress_days: int
) -> RoleFeedbackState:
    since = datetime.now(UTC) - timedelta(days=suppress_days)
    not_relevant = await session.scalars(
        select(InsightCard.fingerprint)
        .join(Feedback, Feedback.card_id == InsightCard.id)
        .where(
            InsightCard.role_node_id == role_node_id,
            Feedback.type == "not_relevant",
            Feedback.created_at > since,
        )
    )
    # Impossible: the same action on the same entity is never suggested again to this role.
    impossible = await session.scalars(
        select(InsightCard.fingerprint)
        .join(Feedback, Feedback.card_id == InsightCard.id)
        .where(InsightCard.role_node_id == role_node_id, Feedback.type == "impossible")
    )
    rules = (
        await session.scalars(
            select(FeedbackRule).where(
                FeedbackRule.role_node_id == role_node_id, FeedbackRule.status == "active"
            )
        )
    ).all()
    forbid = {r.fingerprint for r in rules if r.rule_type == "forbid" and r.fingerprint}
    downweight_ids = {r.metric_id for r in rules if r.rule_type == "downweight" and r.metric_id}
    downweighted = await session.scalars(select(Metric.key).where(Metric.id.in_(downweight_ids)))
    open_fps = await session.scalars(
        select(InsightCard.fingerprint).where(
            InsightCard.role_node_id == role_node_id, InsightCard.status == "open"
        )
    )
    return RoleFeedbackState(
        suppressed_fingerprints=frozenset([*not_relevant, *impossible, *forbid]),
        downweighted_metrics=frozenset(downweighted),
        open_fingerprints=frozenset(open_fps),
    )


async def selected_signals(
    session: AsyncSession, run_id: uuid.UUID, role_node_id: uuid.UUID
) -> Sequence[tuple[Signal, str]]:
    rows = await session.execute(
        select(Signal, Metric.key)
        .join(Metric, Metric.id == Signal.metric_id)
        .where(
            Signal.run_id == run_id,
            Signal.role_node_id == role_node_id,
            Signal.status.in_(("selected", "carded")),
        )
        .order_by(Signal.score.desc())
    )
    return [(sig, key) for sig, key in rows.tuples()]


async def role_with_department(
    session: AsyncSession, role_node_id: uuid.UUID
) -> tuple[RoleNode, Department | None] | None:
    row = (
        await session.execute(
            select(RoleNode, Department)
            .outerjoin(Department, Department.id == RoleNode.department_id)
            .where(RoleNode.id == role_node_id)
        )
    ).first()
    return (row[0], row[1]) if row else None


async def active_rules(session: AsyncSession, role_node_id: uuid.UUID) -> Sequence[FeedbackRule]:
    rows = await session.scalars(
        select(FeedbackRule).where(
            FeedbackRule.role_node_id == role_node_id, FeedbackRule.status == "active"
        )
    )
    return rows.all()


async def prompt_body(session: AsyncSession, key: str) -> str:
    body = await session.scalar(select(PromptTemplate.body).where(PromptTemplate.key == key))
    return body or ""


async def latest_call(
    session: AsyncSession, run_id: uuid.UUID, role_node_id: uuid.UUID
) -> LlmCallLog | None:
    result: LlmCallLog | None = await session.scalar(
        select(LlmCallLog)
        .where(and_(LlmCallLog.run_id == run_id, LlmCallLog.role_node_id == role_node_id))
        .order_by(LlmCallLog.created_at.desc())
        .limit(1)
    )
    return result
