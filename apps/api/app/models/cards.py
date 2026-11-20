"""Cards, feedback, rules, initiatives, outcomes, roll-up summaries and the audit log."""

import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    ARRAY,
    CheckConstraint,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantScoped, Timestamped, UUIDPk, one_of

CARD_STATUSES = ("open", "actioned", "not_relevant", "impossible", "expired")


class InsightCard(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "insight_card"
    __table_args__ = (
        one_of("status", CARD_STATUSES),
        one_of("language", ("en", "fr")),
        # At most one open card per fingerprint per role (validation also checks this).
        Index(
            "uq_insight_card_open_fingerprint",
            "tenant_id",
            "role_node_id",
            "fingerprint",
            unique=True,
            postgresql_where=text("status = 'open'"),
        ),
        Index("ix_insight_card_role_status", "role_node_id", "status"),
    )

    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="SET NULL")
    )
    signal_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("signal.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(15), default="open")
    title: Mapped[str] = mapped_column(String(120))
    what: Mapped[str] = mapped_column(Text)
    so_what: Mapped[str] = mapped_column(Text)
    now_what: Mapped[str] = mapped_column(Text)
    decision_used: Mapped[str | None] = mapped_column(Text)
    evidence: Mapped[dict[str, Any]] = mapped_column(JSONB)
    expected_impact: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    impact_unit: Mapped[str] = mapped_column(String(10))
    confidence: Mapped[Decimal] = mapped_column(Numeric(4, 3))
    priority: Mapped[int] = mapped_column(Integer)
    fingerprint: Mapped[str] = mapped_column(String(400))
    language: Mapped[str] = mapped_column(String(2))
    suggested_window_days: Mapped[int | None] = mapped_column(Integer)
    suggested_metric_key: Mapped[str | None] = mapped_column(String(80))
    generated_by: Mapped[str | None] = mapped_column(String(120))  # provider/model
    agent_key: Mapped[str | None] = mapped_column(String(80))
    agent_version: Mapped[int | None] = mapped_column(Integer)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class CardRejection(UUIDPk, TenantScoped, Timestamped, Base):
    """A proposed card that failed validation, with the reasons (spec: rejections are logged)."""

    __tablename__ = "card_rejection"

    run_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    reasons: Mapped[list[str]] = mapped_column(ARRAY(Text))


class Feedback(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "feedback"
    __table_args__ = (
        one_of("type", ("not_relevant", "impossible")),
        CheckConstraint(
            "type <> 'impossible' OR length(trim(coalesce(reason, ''))) > 0",
            name="impossible_needs_reason",
        ),
    )

    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("insight_card.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="CASCADE")
    )
    type: Mapped[str] = mapped_column(String(15))
    reason: Mapped[str | None] = mapped_column(Text)


class FeedbackRule(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "feedback_rule"
    __table_args__ = (
        one_of("rule_type", ("downweight", "forbid")),
        one_of("status", ("proposed", "active", "retired", "rejected")),
    )

    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE"), index=True
    )
    rule_type: Mapped[str] = mapped_column(String(10))
    metric_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("metric.id", ondelete="CASCADE")
    )
    fingerprint: Mapped[str | None] = mapped_column(String(400))
    text: Mapped[str] = mapped_column(Text)
    source_feedback_ids: Mapped[list[uuid.UUID]] = mapped_column(
        ARRAY(UUID(as_uuid=True)), default=list
    )
    status: Mapped[str] = mapped_column(String(10), default="proposed")
    reviewed_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="SET NULL")
    )
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # The rule drafter agent's clearer wording, offered to the reviewer (ADR 0022).
    suggested_text: Mapped[str | None] = mapped_column(Text)


class Initiative(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "initiative"
    __table_args__ = (
        one_of("status", ("in_progress", "done", "cancelled")),
        one_of("keep_or_stop", ("keep", "stop")),
    )

    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("insight_card.id", ondelete="CASCADE"), unique=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE"), index=True
    )
    owner_person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="RESTRICT")
    )
    metric_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("metric.id", ondelete="RESTRICT")
    )
    due_date: Mapped[date | None] = mapped_column(Date)
    started_on: Mapped[date] = mapped_column(Date, server_default=text("current_date"))
    # The card's exposure (open lines, units on hand, ...) frozen at action time (ADR 0019).
    exposure: Mapped[Decimal] = mapped_column(Numeric(18, 4), server_default=text("1"))
    baseline_value: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    baseline_period: Mapped[str] = mapped_column(String(80))
    window_days: Mapped[int] = mapped_column(Integer)
    target_value: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    status: Mapped[str] = mapped_column(String(15), default="in_progress")
    keep_or_stop: Mapped[str | None] = mapped_column(String(4))
    keep_or_stop_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Outcome(UUIDPk, TenantScoped, Timestamped, Base):
    """One row per measurement (midpoint and end of window)."""

    __tablename__ = "outcome"
    __table_args__ = (one_of("kind", ("midpoint", "end")),)

    initiative_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("initiative.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    kind: Mapped[str] = mapped_column(String(10))
    measured_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    value: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    delta_vs_baseline: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    value_captured: Mapped[Decimal] = mapped_column(Numeric(14, 2))
    currency: Mapped[str] = mapped_column(String(3))


class RoleSummary(TenantScoped, Base):
    """Cached roll-up per node, refreshed by /internal/rollup (ADR 0007)."""

    __tablename__ = "role_summary"

    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE"), primary_key=True
    )
    open_cards: Mapped[int] = mapped_column(Integer, default=0)
    open_cards_subtree: Mapped[int] = mapped_column(Integer, default=0)
    value_captured: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal(0))
    value_captured_subtree: Mapped[Decimal] = mapped_column(Numeric(14, 2), default=Decimal(0))
    refreshed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


class AuditLog(UUIDPk, TenantScoped, Base):
    """Append only: UPDATE and DELETE are revoked from the runtime roles."""

    __tablename__ = "audit_log"

    actor: Mapped[str] = mapped_column(String(200))
    action: Mapped[str] = mapped_column(String(80))
    object_type: Mapped[str] = mapped_column(String(80))
    object_id: Mapped[str | None] = mapped_column(String(80))
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))


class CardTranslation(UUIDPk, TenantScoped, Timestamped, Base):
    """On-demand translation of a card, cached (spec: card text is translated on demand)."""

    __tablename__ = "card_translation"
    __table_args__ = (UniqueConstraint("card_id", "language"), one_of("language", ("en", "fr")))

    card_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("insight_card.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE")
    )
    language: Mapped[str] = mapped_column(String(2))
    title: Mapped[str] = mapped_column(String(120))
    what: Mapped[str] = mapped_column(Text)
    so_what: Mapped[str] = mapped_column(Text)
    now_what: Mapped[str] = mapped_column(Text)
    generated_by: Mapped[str] = mapped_column(String(160))
