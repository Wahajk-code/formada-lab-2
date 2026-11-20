"""Catalog: global versioned definitions (from catalog/*.yaml) and per-tenant metric wiring."""

import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantScoped, Timestamped, UUIDPk

PLAYBOOKS = ("purchasing", "sales")


class DataArchetype(Timestamped, Base):
    """A logical table shape (e.g. purchase_order_line) that templates are written against."""

    __tablename__ = "data_archetype"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    description: Mapped[str] = mapped_column(Text)
    columns: Mapped[dict[str, Any]] = mapped_column(JSONB)


class ArchetypeMapping(UUIDPk, TenantScoped, Timestamped, Base):
    """Maps an archetype's logical columns onto the tenant's physical warehouse table."""

    __tablename__ = "archetype_mapping"
    __table_args__ = (UniqueConstraint("tenant_id", "archetype_key"),)

    archetype_key: Mapped[str] = mapped_column(ForeignKey("data_archetype.key"))
    source: Mapped[str] = mapped_column(Text)  # a table name or a single read-only SELECT
    columns: Mapped[dict[str, str]] = mapped_column(JSONB)


class SqlTemplate(UUIDPk, Timestamped, Base):
    __tablename__ = "sql_template"
    __table_args__ = (UniqueConstraint("key", "version"),)

    key: Mapped[str] = mapped_column(String(80))
    version: Mapped[int] = mapped_column(Integer)
    playbook: Mapped[str] = mapped_column(String(50))
    aliases: Mapped[dict[str, str]] = mapped_column(JSONB)  # SQL alias -> archetype key
    description: Mapped[str] = mapped_column(Text)
    sql: Mapped[str] = mapped_column(Text)
    drivers: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)  # name -> {sql, exposure}
    params_schema: Mapped[dict[str, Any]] = mapped_column(JSONB)


class CustomTemplate(UUIDPk, TenantScoped, Timestamped, Base):
    """A metric template for one workspace only (never part of a data archetype).

    A draft can be edited. Once the team approves it, it is frozen: a change is a new version.
    It carries the same fields a catalog template does, so the pipeline runs both the same way.
    """

    __tablename__ = "custom_template"
    __table_args__ = (UniqueConstraint("tenant_id", "key", "version"),)

    key: Mapped[str] = mapped_column(String(80))
    version: Mapped[int] = mapped_column(Integer)
    name: Mapped[str] = mapped_column(String(200))
    playbook: Mapped[str] = mapped_column(String(50))
    description: Mapped[str] = mapped_column(Text)
    instructions: Mapped[str] = mapped_column(Text, default="")  # what the team asked for
    aliases: Mapped[dict[str, str]] = mapped_column(JSONB)  # SQL alias -> archetype key
    sql: Mapped[str] = mapped_column(Text)
    drivers: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    params_schema: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    origin: Mapped[str] = mapped_column(String(10))  # hand | ai
    status: Mapped[str] = mapped_column(String(10), default="draft")  # draft | approved | retired
    dry_run: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_by: Mapped[str] = mapped_column(String(320))
    approved_by: Mapped[str | None] = mapped_column(String(320))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class RoleArchetype(Timestamped, Base):
    """Default profile for a kind of role (decisions, KPIs, metrics with weights)."""

    __tablename__ = "role_archetype"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    playbook: Mapped[str] = mapped_column(String(50))
    definition: Mapped[dict[str, Any]] = mapped_column(JSONB)


class PromptTemplate(Timestamped, Base):
    __tablename__ = "prompt_template"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    version: Mapped[int] = mapped_column(Integer)
    body: Mapped[str] = mapped_column(Text)


class Metric(UUIDPk, TenantScoped, Timestamped, Base):
    """unit_value converts one unit of change into money for impact and the ledger."""

    __tablename__ = "metric"
    __table_args__ = (UniqueConstraint("tenant_id", "key"),)

    key: Mapped[str] = mapped_column(String(80))
    name: Mapped[str] = mapped_column(String(200))
    sql_template_key: Mapped[str] = mapped_column(String(80))
    sql_template_version: Mapped[int] = mapped_column(Integer)
    params: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    unit: Mapped[str] = mapped_column(String(30))
    higher_is_better: Mapped[bool] = mapped_column(Boolean)
    unit_value: Mapped[Decimal] = mapped_column(Numeric(14, 4))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    timeout_count: Mapped[int] = mapped_column(Integer, default=0)


class RoleMetric(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "role_metric"
    __table_args__ = (UniqueConstraint("role_node_id", "metric_id"),)

    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE"), index=True
    )
    metric_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("metric.id", ondelete="CASCADE"), index=True
    )
    weight: Mapped[Decimal] = mapped_column(Numeric(6, 3), default=Decimal(1))
    threshold: Mapped[Decimal | None] = mapped_column(Numeric(14, 4))
    daily_check: Mapped[bool] = mapped_column(Boolean, default=False)
