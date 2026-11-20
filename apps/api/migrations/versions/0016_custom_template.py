"""Custom metric templates, one workspace only (onboarding optimisation plan)

A customer-specific metric the team adds on top of the catalog (by hand or drafted by AI from
the team's instructions). It lives in this workspace only and is never added to a data
archetype. A draft can be edited; once the team approves it, it is frozen: change it by adding a
new version, like a catalog template.

Revision ID: 0016
Revises: 0015
Create Date: 2026-11-17 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0016"
down_revision: str | Sequence[str] | None = "0015"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "custom_template",
        sa.Column("id", sa.UUID(), server_default=sa.text("gen_random_uuid()"), nullable=False),
        sa.Column("tenant_id", sa.UUID(), nullable=False),
        sa.Column("key", sa.String(length=80), nullable=False),
        sa.Column("version", sa.Integer(), nullable=False),
        sa.Column("name", sa.String(length=200), nullable=False),
        sa.Column("playbook", sa.String(length=50), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("instructions", sa.Text(), nullable=False),
        sa.Column("aliases", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("sql", sa.Text(), nullable=False),
        sa.Column("drivers", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("params_schema", postgresql.JSONB(astext_type=sa.Text()), nullable=False),
        sa.Column("origin", sa.String(length=10), nullable=False),
        sa.Column("status", sa.String(length=10), nullable=False),
        sa.Column("dry_run", postgresql.JSONB(astext_type=sa.Text()), nullable=True),
        sa.Column("created_by", sa.String(length=320), nullable=False),
        sa.Column("approved_by", sa.String(length=320), nullable=True),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False
        ),
        sa.CheckConstraint("origin IN ('hand', 'ai')", name=op.f("ck_custom_template_origin")),
        sa.CheckConstraint(
            "status IN ('draft', 'approved', 'retired')", name=op.f("ck_custom_template_status")
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name=op.f("fk_custom_template_tenant_id_tenant"),
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_custom_template")),
        sa.UniqueConstraint("tenant_id", "key", "version", name="uq_custom_template_key_version"),
    )
    op.create_index("ix_custom_template_tenant_id", "custom_template", ["tenant_id"])
    op.execute("ALTER TABLE custom_template ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE custom_template FORCE ROW LEVEL SECURITY")
    using = "tenant_id = app_tenant_id()"
    op.execute(f"CREATE POLICY tenant_isolation ON custom_template USING ({using}) WITH CHECK ({using})")
    # Template SQL is our team's work: the client app never reads it.
    op.execute("REVOKE ALL ON custom_template FROM app_user")


def downgrade() -> None:
    op.drop_table("custom_template")
