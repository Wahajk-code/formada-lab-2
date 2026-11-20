"""AI onboarding (ADR 0026): onboarding_step, and the onboarding agent kind

- onboarding_step: one row per agent proposal (discovery, mapping, org, metrics, rules) with
  the shape-only input, the answer, the code checks and the approval. Tenant table with RLS;
  service-only like llm_call_log (the console reads it through the service connection).
- agent.kind accepts 'onboarding'.

Revision ID: 0011
Revises: 0010
Create Date: 2026-11-04 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0011"
down_revision: str | Sequence[str] | None = "0010"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS_OLD = "kind IN ('card_writer', 'translator', 'rule_drafter')"
KINDS_NEW = "kind IN ('card_writer', 'translator', 'rule_drafter', 'onboarding')"


def upgrade() -> None:
    op.create_table(
        "onboarding_step",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("step", sa.String(length=20), nullable=False),
        sa.Column("status", sa.String(length=12), nullable=False),
        sa.Column("input", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("output", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("checks", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False),
        sa.Column("agent_key", sa.String(length=80), nullable=True),
        sa.Column("agent_version", sa.Integer(), nullable=True),
        sa.Column("provider", sa.String(length=20), nullable=True),
        sa.Column("model", sa.String(length=80), nullable=True),
        sa.Column("input_tokens", sa.Integer(), nullable=False),
        sa.Column("output_tokens", sa.Integer(), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=False),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("created_by", sa.String(length=320), nullable=False),
        sa.Column("approved_by", sa.String(length=320), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applied", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("now()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "step IN ('discovery', 'mapping', 'org', 'metrics', 'rules')",
            name=op.f("ck_onboarding_step_step"),
        ),
        sa.CheckConstraint(
            "status IN ('running', 'proposed', 'approved', 'failed', 'superseded')",
            name=op.f("ck_onboarding_step_status"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name=op.f("fk_onboarding_step_tenant_id_tenant"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_onboarding_step")),
    )
    op.create_index(
        op.f("ix_onboarding_step_tenant_id"), "onboarding_step", ["tenant_id"], unique=False
    )
    op.create_index(op.f("ix_onboarding_step_step"), "onboarding_step", ["step"], unique=False)
    op.execute("ALTER TABLE onboarding_step ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE onboarding_step FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON onboarding_step "
        "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())"
    )
    op.execute("REVOKE ALL ON onboarding_step FROM app_user")

    op.drop_constraint(op.f("ck_agent_kind"), "agent", type_="check")
    op.create_check_constraint(op.f("ck_agent_kind"), "agent", KINDS_NEW)


def downgrade() -> None:
    op.execute("DELETE FROM agent WHERE kind = 'onboarding'")
    op.drop_constraint(op.f("ck_agent_kind"), "agent", type_="check")
    op.create_check_constraint(op.f("ck_agent_kind"), "agent", KINDS_OLD)
    op.drop_table("onboarding_step")
