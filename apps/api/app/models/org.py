import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    ARRAY,
    Boolean,
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

LOCALES = ("en", "fr")
CADENCES = ("weekly", "daily")
HOLDER_TYPES = ("human", "human_ai_assist", "ai_agent", "vacant")
LIFECYCLES = ("onboarding", "live")


class Tenant(UUIDPk, Timestamped, Base):
    __tablename__ = "tenant"
    __table_args__ = (
        one_of("locale", LOCALES),
        one_of("default_cadence", CADENCES),
        one_of("lifecycle", LIFECYCLES),
    )

    name: Mapped[str] = mapped_column(String(200))
    locale: Mapped[str] = mapped_column(String(2), default="en")
    plan: Mapped[str] = mapped_column(String(50), default="pilot")
    default_cadence: Mapped[str] = mapped_column(String(10), default="weekly")
    timezone: Mapped[str] = mapped_column(String(64), default="America/Toronto")
    currency: Mapped[str] = mapped_column(String(3), default="CAD")
    hide_cards_from_roleless_admins: Mapped[bool] = mapped_column(Boolean, default=False)
    # onboarding: the client sees only onboarding, settings and notifications (ADR 0027).
    lifecycle: Mapped[str] = mapped_column(String(12), default="live", server_default="live")
    live_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # Next onboarding check-in our team schedules with the client (ADR 0030).
    checkin_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    checkin_note: Mapped[str] = mapped_column(Text, default="", server_default="")
    checkin_lead: Mapped[str] = mapped_column(String(200), default="", server_default="")


class LoginIdentity(UUIDPk, Timestamped, Base):
    """Global identity directory (no RLS): maps an auth subject to its tenant and person.
    Read before a tenant context exists, so it holds no tenant data beyond the ids."""

    __tablename__ = "login_identity"

    email: Mapped[str] = mapped_column(String(320), unique=True)
    tenant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenant.id", ondelete="CASCADE")
    )
    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="CASCADE")
    )
    # In-app sign-in (ADR 0023). Only the service connection reads or writes these.
    password_hash: Mapped[str | None] = mapped_column(String(200))
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    token_version: Mapped[int] = mapped_column(Integer, default=0)  # bump = sign out everywhere
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Person(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "person"
    __table_args__ = (
        UniqueConstraint("tenant_id", "email"),
        one_of("locale", LOCALES),
        one_of("app_role", ("owner", "admin", "member")),
    )

    email: Mapped[str] = mapped_column(String(320))
    name: Mapped[str] = mapped_column(String(200))
    locale: Mapped[str] = mapped_column(String(2), default="en")
    # owner | admin | member (ADR 0021)
    app_role: Mapped[str] = mapped_column(String(10), default="member")
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Department(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "department"
    __table_args__ = (UniqueConstraint("tenant_id", "name"),)

    name: Mapped[str] = mapped_column(String(120))
    playbook: Mapped[str | None] = mapped_column(String(50))
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    head_role_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("role_node.id", ondelete="SET NULL", use_alter=True),
    )


class RoleNode(UUIDPk, TenantScoped, Timestamped, Base):
    """The CEO node has no department and no parent."""

    __tablename__ = "role_node"
    __table_args__ = (
        one_of("holder_type", HOLDER_TYPES),
        one_of("cadence", CADENCES),
        one_of("language", LOCALES),
    )

    department_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("department.id", ondelete="SET NULL"), index=True
    )
    parent_role_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="RESTRICT"), index=True
    )
    title: Mapped[str] = mapped_column(String(120))
    role_archetype_key: Mapped[str | None] = mapped_column(String(80))
    holder_type: Mapped[str] = mapped_column(String(20), default="human")
    decisions_owned: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    decisions_forbidden: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    kpi_notes: Mapped[str | None] = mapped_column(Text)
    cadence: Mapped[str] = mapped_column(String(10), default="weekly")
    language: Mapped[str] = mapped_column(String(2), default="en")
    is_draft: Mapped[bool] = mapped_column(Boolean, default=False)


class RoleClosure(TenantScoped, Base):
    """Transitive closure of role_node (including depth-0 self rows). Rebuilt by
    rebuild_role_closure(tenant_id) on every org change; drives visibility and roll-ups."""

    __tablename__ = "role_closure"

    ancestor_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE"), primary_key=True
    )
    descendant_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("role_node.id", ondelete="CASCADE"),
        primary_key=True,
        index=True,
    )
    depth: Mapped[int] = mapped_column(Integer)


class RoleAssignment(UUIDPk, TenantScoped, Timestamped, Base):
    """owner can action cards; viewer reads. grant_effect=deny removes a subtree (ADR 0006)."""

    __tablename__ = "role_assignment"
    __table_args__ = (
        UniqueConstraint("person_id", "role_node_id"),
        one_of("permission", ("viewer", "owner")),
        one_of("grant_effect", ("allow", "deny")),
    )

    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="CASCADE"), index=True
    )
    role_node_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("role_node.id", ondelete="CASCADE"), index=True
    )
    permission: Mapped[str] = mapped_column(String(10), default="owner")
    is_primary: Mapped[bool] = mapped_column(Boolean, default=True)
    grant_effect: Mapped[str] = mapped_column(String(5), default="allow")


class WarehouseConnection(UUIDPk, TenantScoped, Timestamped, Base):
    """secret_ref points into the vault; no key material is ever stored here."""

    __tablename__ = "warehouse_connection"
    __table_args__ = (
        UniqueConstraint("tenant_id"),
        one_of("status", ("pending", "ok", "failed")),
    )

    account_identifier: Mapped[str] = mapped_column(String(200))
    user_name: Mapped[str] = mapped_column(String(200))
    role_name: Mapped[str] = mapped_column(String(200))
    warehouse_name: Mapped[str] = mapped_column(String(200))
    database_name: Mapped[str] = mapped_column(String(200))
    schemas: Mapped[list[str]] = mapped_column(ARRAY(Text), default=list)
    secret_ref: Mapped[str] = mapped_column(String(300))
    status: Mapped[str] = mapped_column(String(10), default="pending")
    last_tested_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    test_result: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    monthly_credit_cap: Mapped[Decimal] = mapped_column(Numeric(10, 2), default=Decimal(25))


class Invite(UUIDPk, TenantScoped, Timestamped, Base):
    """Email invite into a workspace (ADR 0021). Only the hash of the link's secret is stored."""

    __tablename__ = "invite"
    __table_args__ = (
        one_of("app_role", ("owner", "admin", "member")),
        one_of("status", ("pending", "accepted", "revoked")),
        Index("ix_invite_token_hash", "token_hash", unique=True),
    )

    email: Mapped[str] = mapped_column(String(320))
    name: Mapped[str] = mapped_column(String(200))
    app_role: Mapped[str] = mapped_column(String(10), default="member")
    locale: Mapped[str] = mapped_column(String(2), default="en")
    # [{"role_node_id": "...", "permission": "owner" | "viewer"}]
    assignments: Mapped[list[dict[str, str]]] = mapped_column(JSONB, default=list)
    token_hash: Mapped[str] = mapped_column(String(64))
    status: Mapped[str] = mapped_column(String(10), default="pending")
    invited_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="SET NULL")
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
