"""Validation: control totals, their checks, and test results (accuracy plan)

A control total is a figure the client already trusts (net sales for a week, units on hand), given
at onboarding. Each run compares our number with it and stores the outcome in control_check.
validation_result keeps what the team measured on purpose: a backtest of detection on history, a
stability test (an AI step asked twice) and a regression test (a prompt replayed on an approved
answer). All of it is the internal team's work: the client app never reads these tables.

Revision ID: 0018
Revises: 0017
Create Date: 2026-11-28 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0018"
down_revision: str | Sequence[str] | None = "0017"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def _rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    using = "tenant_id = app_tenant_id()"
    op.execute(f"CREATE POLICY tenant_isolation ON {table} USING ({using}) WITH CHECK ({using})")
    op.execute(f"REVOKE ALL ON {table} FROM app_user")  # our team's work, not the client's


def _id() -> sa.Column:  # type: ignore[type-arg]
    return sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False)


def _created() -> sa.Column:  # type: ignore[type-arg]
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
    )


def upgrade() -> None:
    op.create_table(
        "control_total",
        _id(),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("metric_key", sa.String(length=80), nullable=False),
        sa.Column("entity", sa.String(length=200), nullable=True),
        sa.Column("week", sa.Date(), nullable=True),
        sa.Column("expected", sa.Numeric(18, 4), nullable=False),
        sa.Column("tolerance_pct", sa.Numeric(6, 2), nullable=True),
        sa.Column("source", sa.Text(), server_default="", nullable=False),
        sa.Column("active", sa.Boolean(), server_default=sa.text("true"), nullable=False),
        sa.Column("created_by", sa.String(length=320), nullable=False),
        _created(),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name=op.f("fk_control_total_tenant_id_tenant"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_control_total")),
        sa.UniqueConstraint("tenant_id", "key", name="uq_control_total_key"),
    )
    op.create_index("ix_control_total_tenant_id", "control_total", ["tenant_id"])
    _rls("control_total")

    op.create_table(
        "control_check",
        _id(),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("control_id", sa.UUID(), nullable=False),
        sa.Column("run_id", sa.UUID(), nullable=True),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("expected", sa.Numeric(18, 4), nullable=False),
        sa.Column("ours", sa.Numeric(18, 4), nullable=True),
        sa.Column("diff_pct", sa.Numeric(10, 3), nullable=True),
        sa.Column("tolerance_pct", sa.Numeric(6, 2), nullable=False),
        _created(),
        sa.CheckConstraint(
            "status IN ('match', 'off', 'missing')", name=op.f("ck_control_check_status")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name=op.f("fk_control_check_tenant_id_tenant"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["control_id"],
            ["control_total.id"],
            name=op.f("fk_control_check_control_id_control_total"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["run_id"], ["run.id"], name=op.f("fk_control_check_run_id_run"), ondelete="SET NULL"
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_control_check")),
        sa.UniqueConstraint("control_id", "run_id", name="uq_control_check_run"),
    )
    op.create_index("ix_control_check_tenant_id", "control_check", ["tenant_id"])
    op.create_index("ix_control_check_control_id", "control_check", ["control_id", "created_at"])
    _rls("control_check")

    op.create_table(
        "validation_result",
        _id(),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("kind", sa.String(length=12), nullable=False),
        sa.Column("subject", sa.String(length=120), nullable=False),
        sa.Column("verdict", sa.String(length=20), nullable=False),
        sa.Column("summary", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("detail", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("created_by", sa.String(length=320), nullable=False),
        _created(),
        sa.CheckConstraint(
            "kind IN ('backtest', 'stability', 'regression')",
            name=op.f("ck_validation_result_kind"),
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name=op.f("fk_validation_result_tenant_id_tenant"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_validation_result")),
    )
    op.create_index("ix_validation_result_tenant_id", "validation_result", ["tenant_id"])
    op.create_index(
        "ix_validation_result_kind",
        "validation_result",
        ["tenant_id", "kind", "subject", "created_at"],
    )
    _rls("validation_result")


def downgrade() -> None:
    op.drop_table("validation_result")
    op.drop_table("control_check")
    op.drop_table("control_total")
