"""Sequential onboarding with sign-off by both sides (ADR 0027)

- onboarding_signoff: one row per workspace and step with the team's and the client's approval
  and the client-safe summary of what was approved. Tenant table with RLS. The client role may
  read it and set only its own approval columns.

Revision ID: 0013
Revises: 0012
Create Date: 2026-11-05 14:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0013"
down_revision: str | Sequence[str] | None = "0012"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STEPS = "'connect', 'discovery', 'mapping', 'org', 'metrics', 'rules', 'trial'"


def upgrade() -> None:
    op.create_table(
        "onboarding_signoff",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("step", sa.String(length=20), nullable=False),
        sa.Column("summary", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("team_by", sa.String(length=320), nullable=True),
        sa.Column("team_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("client_by", sa.String(length=200), nullable=True),
        sa.Column("client_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reopened", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("reopened_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("reopen_note", sa.Text(), nullable=False, server_default=""),
        sa.CheckConstraint(f"step IN ({STEPS})", name=op.f("ck_onboarding_signoff_step")),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name="fk_onboarding_signoff_tenant_id_tenant",
            ondelete="CASCADE",
        ),
        sa.UniqueConstraint("tenant_id", "step", name="uq_onboarding_signoff_tenant_id"),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_onboarding_signoff")),
    )
    op.create_index("ix_onboarding_signoff_tenant_id", "onboarding_signoff", ["tenant_id"])
    op.execute("ALTER TABLE onboarding_signoff ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE onboarding_signoff FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON onboarding_signoff "
        "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())"
    )
    # The client reads the summaries and records its own approval, nothing else.
    op.execute("REVOKE INSERT, UPDATE, DELETE ON onboarding_signoff FROM app_user")
    op.execute("GRANT UPDATE (client_by, client_at) ON onboarding_signoff TO app_user")


def downgrade() -> None:
    op.drop_table("onboarding_signoff")
