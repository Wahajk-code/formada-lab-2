"""llm setting per tenant (ADR 0018)

Revision ID: 0007
Revises: 0006
Create Date: 2026-10-27 18:20:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision: str = "0007"
down_revision: str | Sequence[str] | None = "0006"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

IS_ADMIN = (
    "EXISTS (SELECT 1 FROM person WHERE person.id = app_person_id() AND person.app_role = 'admin')"
)


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table(
        "llm_setting",
        sa.Column("provider", sa.String(length=20), nullable=False),
        sa.Column("model", sa.String(length=80), nullable=False),
        sa.Column("updated_by", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()")),
        sa.Column("tenant_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.ForeignKeyConstraint(
            ["tenant_id"],
            ["tenant.id"],
            name=op.f("fk_llm_setting_tenant_id_tenant"),
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["updated_by"],
            ["person.id"],
            name=op.f("fk_llm_setting_updated_by_person"),
            ondelete="SET NULL",
        ),
        sa.PrimaryKeyConstraint("id", name=op.f("pk_llm_setting")),
        sa.UniqueConstraint("tenant_id", name=op.f("uq_llm_setting_tenant_id")),
    )
    op.create_index(op.f("ix_llm_setting_tenant_id"), "llm_setting", ["tenant_id"])

    op.execute("ALTER TABLE llm_setting ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE llm_setting FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON llm_setting "
        "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())"
    )
    # Every user may read the choice; only tenant admins may change it (the service checks too).
    op.execute(
        "CREATE POLICY admin_insert ON llm_setting AS RESTRICTIVE FOR INSERT TO app_user "
        f"WITH CHECK ({IS_ADMIN})"
    )
    op.execute(
        "CREATE POLICY admin_update ON llm_setting AS RESTRICTIVE FOR UPDATE TO app_user "
        f"USING ({IS_ADMIN}) WITH CHECK ({IS_ADMIN})"
    )
    op.execute("REVOKE DELETE ON llm_setting FROM app_user")
    op.execute("REVOKE INSERT, UPDATE, DELETE ON llm_setting FROM app_service")


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f("ix_llm_setting_tenant_id"), table_name="llm_setting")
    op.drop_table("llm_setting")
