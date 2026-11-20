"""Onboarding (ADR 0026): every AI proposal, the code checks on it, and who approved it.

One row per attempt. A new proposal for a step supersedes the previous open one; approving
writes the real tables (mappings, org, metrics, rules) and keeps this row as the audit trail.
Service-only: the internal console reads it through the service connection, never app_user.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime, ForeignKey, Integer, String, Text, UniqueConstraint, func
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base, TenantScoped, Timestamped, UUIDPk, one_of

STEPS = ("discovery", "mapping", "org", "metrics", "rules")
STATUSES = ("running", "proposed", "approved", "failed", "superseded")


class OnboardingStep(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "onboarding_step"
    __table_args__ = (one_of("step", STEPS), one_of("status", STATUSES))

    step: Mapped[str] = mapped_column(String(20), index=True)
    status: Mapped[str] = mapped_column(String(12), default="proposed")
    # What the agent was given (shape only), what it answered, and what code found when checking.
    input: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    output: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    checks: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")
    agent_key: Mapped[str | None] = mapped_column(String(80))
    agent_version: Mapped[int | None] = mapped_column(Integer)
    provider: Mapped[str | None] = mapped_column(String(20))
    model: Mapped[str | None] = mapped_column(String(80))
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    latency_ms: Mapped[int] = mapped_column(Integer, default=0)
    error: Mapped[str | None] = mapped_column(Text)
    # How the agent was called and what it reasoned: {"thinking", "effort", "system_chars", ...}.
    trace: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    created_by: Mapped[str] = mapped_column(String(320))
    approved_by: Mapped[str | None] = mapped_column(String(320))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # What approving wrote (ids, keys), so the console can show the result next to the proposal.
    applied: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


# ---- Collaboration with the client (ADR 0027) ------------------------------------------------
# Unlike onboarding_step, these are read by the client app (app_user, tenant RLS): the client
# sees progress, questions and their org draft, never the agent inputs or SQL.

THREAD_STEPS = ("connect", "discovery", "mapping", "org", "metrics", "rules", "trial")
SIDES = ("team", "client")
THREAD_STATUSES = ("open", "resolved")
DRAFT_STATUSES = ("draft", "submitted", "approved")
DRAFT_SOURCES = ("blank", "template", "file", "photo", "microsoft")


class OnboardingThread(UUIDPk, TenantScoped, Timestamped, Base):
    """A question on one onboarding step, asked by either side; open until resolved."""

    __tablename__ = "onboarding_thread"
    __table_args__ = (
        one_of("step", THREAD_STEPS),
        one_of("raised_by", SIDES),
        one_of("waiting_on", SIDES),
        one_of("status", THREAD_STATUSES),
    )

    step: Mapped[str] = mapped_column(String(20), index=True)
    title: Mapped[str] = mapped_column(String(300))
    raised_by: Mapped[str] = mapped_column(String(10))
    waiting_on: Mapped[str] = mapped_column(String(10))  # whose turn it is to answer
    status: Mapped[str] = mapped_column(String(10), default="open")
    resolved_by: Mapped[str | None] = mapped_column(String(320))
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class OnboardingMessage(UUIDPk, TenantScoped, Timestamped, Base):
    __tablename__ = "onboarding_message"
    __table_args__ = (one_of("side", SIDES),)

    thread_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("onboarding_thread.id", ondelete="CASCADE"), index=True
    )
    side: Mapped[str] = mapped_column(String(10))
    author: Mapped[str] = mapped_column(String(200))  # display name, never an email
    body: Mapped[str] = mapped_column(Text)


class OrgDraft(UUIDPk, TenantScoped, Base):
    """The client's org chart while onboarding: one per workspace. `nodes` is a flat list of
    {id, title, parent_id, name, email, department, vacant}; the team turns it into role nodes."""

    __tablename__ = "org_draft"
    __table_args__ = (
        one_of("status", DRAFT_STATUSES),
        one_of("source", DRAFT_SOURCES),
        UniqueConstraint("tenant_id", name="uq_org_draft_tenant_id"),
    )

    nodes: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, default=list)
    source: Mapped[str] = mapped_column(String(12), default="blank")
    status: Mapped[str] = mapped_column(String(12), default="draft")
    updated_by: Mapped[str] = mapped_column(String(200), default="")
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Notification(UUIDPk, TenantScoped, Timestamped, Base):
    """In-app notification for one client person (RLS: tenant and person)."""

    __tablename__ = "notification"

    person_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("person.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(40))
    title: Mapped[str] = mapped_column(String(300))
    body: Mapped[str] = mapped_column(Text, default="")
    link: Mapped[str] = mapped_column(String(300), default="")
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class OnboardingSignoff(UUIDPk, TenantScoped, Base):
    """Both sides' approval of one onboarding step (ADR 0027). A step is done when the team and
    the client have both approved it; the next step opens only then. `summary` is the plain,
    client-safe account of what was approved, written by code when the team approves (the
    client never reads onboarding_step's agent inputs or answers)."""

    __tablename__ = "onboarding_signoff"
    __table_args__ = (
        one_of("step", THREAD_STEPS),
        UniqueConstraint("tenant_id", "step", name="uq_onboarding_signoff_tenant_id"),
    )

    step: Mapped[str] = mapped_column(String(20))
    summary: Mapped[dict[str, Any]] = mapped_column(JSONB, default=dict)
    team_by: Mapped[str | None] = mapped_column(String(320))
    team_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    client_by: Mapped[str | None] = mapped_column(String(200))
    client_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reopened: Mapped[int] = mapped_column(Integer, default=0)
    reopened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reopen_note: Mapped[str] = mapped_column(Text, default="")
