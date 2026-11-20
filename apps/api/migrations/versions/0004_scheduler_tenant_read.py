"""Let the service role list tenants for scheduling (tenants/due). Read-only, tenant table only.

Revision ID: 0004
Revises: 0003
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute("CREATE POLICY scheduler_read ON tenant FOR SELECT TO app_service USING (true)")


def downgrade() -> None:
    op.execute("DROP POLICY scheduler_read ON tenant")
