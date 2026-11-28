"""Validation evidence (accuracy plan): control totals, their checks, and test results.

Service-only: our team reads and writes these through the console. The client app never does."""

import uuid
from datetime import date
from decimal import Decimal
from typing import Any

from sqlalchemy import Boolean, Date, ForeignKey, Numeric, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantScoped, Timestamped, UUIDPk, one_of

CHECK_STATUSES = ("match", "off", "missing")
RESULT_KINDS = ("backtest", "stability", "regression")


class ControlTotal(UUIDPk, TenantScoped, Timestamped, Base):
    """A figure the client already trusts, for one metric (and optionally one entity and week)."""

    __tablename__ = "control_total"
    __table_args__ = (UniqueConstraint("tenant_id", "key", name="uq_control_total_key"),)

    key: Mapped[str] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(200))
    metric_key: Mapped[str] = mapped_column(String(80))
    entity: Mapped[str | None] = mapped_column(String(200))
    week: Mapped[date | None] = mapped_column(Date)  # None: the latest week we hold
    expected: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    tolerance_pct: Mapped[Decimal | None] = mapped_column(Numeric(6, 2))  # None: the default rule
    source: Mapped[str] = mapped_column(Text, default="")  # where the client's figure comes from
    active: Mapped[bool] = mapped_column(Boolean, server_default=text("true"), default=True)
    created_by: Mapped[str] = mapped_column(String(320))


class ControlCheck(UUIDPk, TenantScoped, Timestamped, Base):
    """One comparison of a control total with our number, on one run."""

    __tablename__ = "control_check"
    __table_args__ = (
        one_of("status", CHECK_STATUSES),
        UniqueConstraint("control_id", "run_id", name="uq_control_check_run"),
    )

    control_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("control_total.id", ondelete="CASCADE")
    )
    run_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("run.id", ondelete="SET NULL")
    )
    status: Mapped[str] = mapped_column(String(10))
    expected: Mapped[Decimal] = mapped_column(Numeric(18, 4))
    ours: Mapped[Decimal | None] = mapped_column(Numeric(18, 4))
    diff_pct: Mapped[Decimal | None] = mapped_column(Numeric(10, 3))
    tolerance_pct: Mapped[Decimal] = mapped_column(Numeric(6, 2))


class ValidationResult(UUIDPk, TenantScoped, Timestamped, Base):
    """A test the team ran on purpose: backtest, stability or regression."""

    __tablename__ = "validation_result"
    __table_args__ = (one_of("kind", RESULT_KINDS),)

    kind: Mapped[str] = mapped_column(String(12))
    subject: Mapped[str] = mapped_column(String(120))  # a metric key, or an onboarding step
    verdict: Mapped[str] = mapped_column(String(20))
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    detail: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    created_by: Mapped[str] = mapped_column(String(320))
