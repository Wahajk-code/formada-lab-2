"""Platform tables owned by the internal team: no tenant_id, no RLS (ADR 0020, 0022).

Only the service connection writes them (the console runs through it); app_user can read the
system config and agents (they shape every workspace) but never the staff directory.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, Timestamped, UUIDPk, one_of

STAFF_ROLES = ("admin", "developer")


class StaffUser(UUIDPk, Timestamped, Base):
    """Internal team member. Not a person of any workspace; signs in to the console only."""

    __tablename__ = "staff_user"
    __table_args__ = (one_of("staff_role", STAFF_ROLES),)

    email: Mapped[str] = mapped_column(String(320), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    staff_role: Mapped[str] = mapped_column(String(10), default="admin")
    password_hash: Mapped[str | None] = mapped_column(String(200))
    failed_attempts: Mapped[int] = mapped_column(Integer, default=0)
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    token_version: Mapped[int] = mapped_column(Integer, default=0)
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deactivated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class SystemConfig(Base):
    """System-wide override of a domain/config.py default. Workspace overrides: rules_config."""

    __tablename__ = "system_config"

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    value: Mapped[Any] = mapped_column(JSONB)
    updated_by: Mapped[str] = mapped_column(String(320))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class ConfigChange(UUIDPk, Base):
    """Append-only history of config edits from the console. workspace_id NULL = system level.
    Not a tenant table: only the internal team reads it (via the service connection)."""

    __tablename__ = "config_change"

    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tenant.id", ondelete="CASCADE"), index=True
    )
    scope: Mapped[str] = mapped_column(
        String(20)
    )  # system | workspace | role_metric | metric | llm
    key: Mapped[str] = mapped_column(String(200))
    old_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    new_value: Mapped[Any] = mapped_column(JSONB, nullable=True)
    actor: Mapped[str] = mapped_column(String(320))
    at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class Agent(Timestamped, Base):
    """A specialised AI task with a versioned prompt (ADR 0022)."""

    __tablename__ = "agent"
    __table_args__ = (
        one_of("kind", ("card_writer", "translator", "rule_drafter", "onboarding", "console")),
    )

    key: Mapped[str] = mapped_column(String(80), primary_key=True)
    name: Mapped[str] = mapped_column(String(120))
    kind: Mapped[str] = mapped_column(String(20))
    playbook: Mapped[str | None] = mapped_column(String(50))
    description: Mapped[str] = mapped_column(Text)
    active_version: Mapped[int] = mapped_column(Integer, default=1)
    # Optional "provider/model" just for this agent; empty = the workspace's choice.
    model_override: Mapped[str | None] = mapped_column(String(120))
    use_examples: Mapped[bool] = mapped_column(Boolean, default=True)


class AgentPrompt(Timestamped, Base):
    """One immutable prompt version. Changing a prompt creates a new version."""

    __tablename__ = "agent_prompt"

    agent_key: Mapped[str] = mapped_column(
        String(80), ForeignKey("agent.key", ondelete="CASCADE"), primary_key=True
    )
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    body: Mapped[str] = mapped_column(Text)
    notes: Mapped[str] = mapped_column(Text, default="")
    created_by: Mapped[str] = mapped_column(String(320), default="catalog")


class PasswordReset(UUIDPk, Timestamped, Base):
    """Single-use password reset link (ADR 0023). Only the hash of the link's secret is stored."""

    __tablename__ = "password_reset"
    __table_args__ = (one_of("kind", ("person", "staff")),)

    kind: Mapped[str] = mapped_column(String(10))
    subject_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
