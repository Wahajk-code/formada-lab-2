"""Runs and pipeline artefacts: steps, snapshots, signals, idempotency, LLM call log, config."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantScoped, Timestamped, UUIDPk, one_of

RUN_TYPES = ("weekly", "daily_check", "remeasure", "manual")
RUN_STATUSES = ("running", "succeeded", "partial", "failed")
STEP_STATUSES = ("running", "ok", "skipped", "failed")


class Run(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "run"
    __table_args__ = (one_of("type", RUN_TYPES), one_of("status", RUN_STATUSES))

    type: Mapped[str] = mapped_column(String(20))
    status: Mapped[str] = mapped_column(String(20), default="running")
    scope_role_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="SET NULL")
    )
    scheduled_for: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    period_end: Mapped[date] = mapped_column(Date)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    query_seconds: Mapped[Decimal] = mapped_column(Numeric(12, 3), default=Decimal(0))
    llm_tokens: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    n8n_execution_id: Mapped[str | None] = mapped_column(String(40), index=True)


class RunStep(UUIDPk, TenantScoped, Timestamped, Base):
    """One row per (run, role, step). role_node_id is NULL for tenant-level steps."""

    __tablename__ = "run_step"
    __table_args__ = (
        UniqueConstraint("run_id", "role_node_id", "step", postgresql_nulls_not_distinct=True),
        one_of("status", STEP_STATUSES),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    step: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(10))
    attempts: Mapped[int] = mapped_column(Integer, default=1)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class MetricSnapshot(UUIDPk, TenantScoped, Timestamped, Base):
    """Result of one template run: current value, weekly series per entity, driver breakdowns."""

    __tablename__ = "metric_snapshot"
    __table_args__ = (UniqueConstraint("run_id", "metric_id"),)

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="CASCADE"), index=True
    )
    metric_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("metric.id", ondelete="CASCADE")
    )
    role_node_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="SET NULL")
    )
    period_end: Mapped[date] = mapped_column(Date)
    value: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    series: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    breakdown: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    sql_text: Mapped[str] = mapped_column(Text)
    row_count: Mapped[int] = mapped_column(Integer)
    query_seconds: Mapped[Decimal] = mapped_column(Numeric(10, 3))


class Signal(UUIDPk, TenantScoped, Timestamped, Base):
    """A deterministic finding on a snapshot. fingerprint = metric_key:entity:direction."""

    __tablename__ = "signal"
    __table_args__ = (
        one_of("kind", ("wow_change", "zscore", "threshold", "runout")),
        one_of("direction", ("up", "down")),
        one_of("status", ("new", "suppressed", "selected", "carded", "dropped")),
        Index("ix_signal_run_role", "run_id", "role_node_id"),
    )

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="CASCADE")
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    metric_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("metric.id", ondelete="CASCADE")
    )
    snapshot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("metric_snapshot.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(20))
    entity: Mapped[str] = mapped_column(String(200))
    direction: Mapped[str] = mapped_column(String(4))
    fingerprint: Mapped[str] = mapped_column(String(400), index=True)
    value: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    baseline: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    zscore: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    change_pct: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    est_impact: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    impact_unit: Mapped[str] = mapped_column(String(10))
    score: Mapped[Decimal] = mapped_column(Numeric(16, 4))
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[str] = mapped_column(String(10), default="new")
    status_reason: Mapped[str | None] = mapped_column(Text)


class IdempotencyKey(UUIDPk, TenantScoped, Timestamped, Base):
    """First call stores its response; replays return it. response IS NULL means in flight."""

    __tablename__ = "idempotency_key"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)

    key: Mapped[str] = mapped_column(String(300))
    endpoint: Mapped[str] = mapped_column(String(100))
    response: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class LlmCallLog(UUIDPk, TenantScoped, Timestamped, Base):
    """Raw prompt and response per role and run, purged after 90 days (purge_llm_call_log)."""

    __tablename__ = "llm_call_log"

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    provider: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(80))
    prompt: Mapped[dict[str, Any]] = mapped_column(JSONB)
    response: Mapped[str | None] = mapped_column(Text)
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(10))
    error: Mapped[str | None] = mapped_column(Text)
    agent_key: Mapped[str | None] = mapped_column(String(80))
    agent_version: Mapped[int | None] = mapped_column(Integer)


class RulesConfig(UUIDPk, TenantScoped, Timestamped, Base):
    """Per-tenant overrides of domain/config.py defaults."""

    __tablename__ = "rules_config"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)

    key: Mapped[str] = mapped_column(String(80))
    value: Mapped[Any] = mapped_column(JSONB)


class LlmSetting(UUIDPk, TenantScoped, Timestamped, Base):
    """The tenant's chosen LLM provider and model (ADR 0018). API keys stay in the vault/env."""

    __tablename__ = "llm_setting"
    __table_args__ = (UniqueConstraint("tenant_id"),)

    provider: Mapped[str] = mapped_column(String(20))
    model: Mapped[str] = mapped_column(String(80))
    updated_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="SET NULL")
    )
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
