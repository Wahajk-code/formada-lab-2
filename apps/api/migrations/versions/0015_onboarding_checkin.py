"""Onboarding check-in on the workspace (ADR 0030)

- tenant.checkin_at, checkin_note, checkin_lead: the next setup check-in our team schedules
  with the client. Shown on the client's onboarding page; hidden when not set.

Revision ID: 0015
Revises: 0014
Create Date: 2026-11-10 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | Sequence[str] | None = "0014"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("tenant", sa.Column("checkin_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("tenant", sa.Column("checkin_note", sa.Text(), nullable=False, server_default=""))
    op.add_column(
        "tenant", sa.Column("checkin_lead", sa.String(200), nullable=False, server_default="")
    )


def downgrade() -> None:
    op.drop_column("tenant", "checkin_lead")
    op.drop_column("tenant", "checkin_note")
    op.drop_column("tenant", "checkin_at")
