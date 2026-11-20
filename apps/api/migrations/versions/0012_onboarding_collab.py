"""Onboarding with the client (ADR 0027): workspace lifecycle, questions, org draft, notifications

- tenant.lifecycle ('onboarding' | 'live') and tenant.live_at. Existing workspaces are live.
- onboarding_thread / onboarding_message: questions on an onboarding step, from either side.
- org_draft: the client's org chart while onboarding (one per workspace).
- notification: in-app notifications for one client person (RLS on tenant and person).

All four are tenant tables with RLS enabled and forced. The client app reads and writes them as
app_user; the console uses the service connection. app_user may also read onboarding_step's
step and status columns (progress only).

Revision ID: 0012
Revises: 0011
Create Date: 2026-11-05 10:00:00.000000

"""

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0012"
down_revision: str | Sequence[str] | None = "0011"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STEPS = "'connect', 'discovery', 'mapping', 'org', 'metrics', 'rules', 'trial'"


def _id() -> sa.Column:  # type: ignore[type-arg]
    return sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def _tenant(table: str) -> list[Any]:
    return [
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.ForeignKeyConstraint(
            ["tenant_id"], ["tenant.id"], name=f"fk_{table}_tenant_id_tenant", ondelete="CASCADE"
        ),
    ]


def _created() -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def _rls(table: str, using: str = "tenant_id = app_tenant_id()") -> None:
    op.create_index(f"ix_{table}_tenant_id", table, ["tenant_id"])
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(f"CREATE POLICY tenant_isolation ON {table} USING ({using}) WITH CHECK ({using})")


def upgrade() -> None:
    op.add_column(
        "tenant",
        sa.Column("lifecycle", sa.String(length=12), server_default="live", nullable=False),
    )
    op.add_column("tenant", sa.Column("live_at", sa.DateTime(timezone=True), nullable=True))
    op.create_check_constraint(
        op.f("ck_tenant_lifecycle"), "tenant", "lifecycle IN ('onboarding', 'live')"
    )

    # The client app shows progress: it may read which steps exist and their status, never the
    # agent inputs, answers or checks (column privileges; RLS still applies).
    op.execute(
        "GRANT SELECT (id, tenant_id, step, status, created_at) ON onboarding_step TO app_user"
    )

    op.create_table(
        "onboarding_thread",
        _id(),
        *_tenant("onboarding_thread"),
        sa.Column("step", sa.String(length=20), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("raised_by", sa.String(length=10), nullable=False),
        sa.Column("waiting_on", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("resolved_by", sa.String(length=320), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        _created(),
        sa.CheckConstraint(f"step IN ({STEPS})", name=op.f("ck_onboarding_thread_step")),
        sa.CheckConstraint(
            "raised_by IN ('team', 'client')", name=op.f("ck_onboarding_thread_raised_by")
        ),
        sa.CheckConstraint(
            "waiting_on IN ('team', 'client')", name=op.f("ck_onboarding_thread_waiting_on")
        ),
        sa.CheckConstraint(
            "status IN ('open', 'resolved')", name=op.f("ck_onboarding_thread_status")
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_onboarding_thread")),
    )
    op.create_index("ix_onboarding_thread_step", "onboarding_thread", ["step"])
    _rls("onboarding_thread")

    op.create_table(
        "onboarding_message",
        _id(),
        *_tenant("onboarding_message"),
        sa.Column("thread_id", sa.UUID(), nullable=False),
        sa.Column("side", sa.String(length=10), nullable=False),
        sa.Column("author", sa.String(length=200), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        _created(),
        sa.CheckConstraint("side IN ('team', 'client')", name=op.f("ck_onboarding_message_side")),
        sa.ForeignKeyConstraint(
            ["thread_id"],
            ["onboarding_thread.id"],
            name=op.f("fk_onboarding_message_thread_id_onboarding_thread"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_onboarding_message")),
    )
    op.create_index("ix_onboarding_message_thread_id", "onboarding_message", ["thread_id"])
    _rls("onboarding_message")

    op.create_table(
        "org_draft",
        _id(),
        *_tenant("org_draft"),
        sa.Column("nodes", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("source", sa.String(length=12), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("updated_by", sa.String(length=200), nullable=False),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.Column("submitted_at", sa.DateTime(timezone=True), nullable=True),
        sa.CheckConstraint(
            "status IN ('draft', 'submitted', 'approved')", name=op.f("ck_org_draft_status")
        ),
        sa.CheckConstraint(
            "source IN ('blank', 'template', 'file', 'photo', 'microsoft')",
            name=op.f("ck_org_draft_source"),
        ),
        sa.UniqueConstraint("tenant_id", name="uq_org_draft_tenant_id"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_org_draft")),
    )
    _rls("org_draft")

    op.create_table(
        "notification",
        _id(),
        *_tenant("notification"),
        sa.Column("person_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=40), nullable=False),
        sa.Column("title", sa.String(length=300), nullable=False),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("link", sa.String(length=300), nullable=False),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        _created(),
        sa.ForeignKeyConstraint(
            ["person_id"],
            ["person.id"],
            name=op.f("fk_notification_person_id_person"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_notification")),
    )
    op.create_index("ix_notification_person_id", "notification", ["person_id"])
    # A person sees only their own; the service connection (no person set) sees the tenant's.
    _rls(
        "notification",
        "tenant_id = app_tenant_id() AND (app_person_id() IS NULL OR person_id = app_person_id())",
    )


def downgrade() -> None:
    op.execute("REVOKE ALL ON onboarding_step FROM app_user")
    op.drop_table("notification")
    op.drop_table("org_draft")
    op.drop_table("onboarding_message")
    op.drop_table("onboarding_thread")
    op.drop_constraint(op.f("ck_tenant_lifecycle"), "tenant", type_="check")
    op.drop_column("tenant", "live_at")
    op.drop_column("tenant", "lifecycle")
