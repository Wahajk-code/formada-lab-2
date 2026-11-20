"""What the model reasoned and how it was called, per onboarding step (AI lab)

Revision ID: 0017
Revises: 0016
Create Date: 2026-11-18 09:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0017"
down_revision: str | Sequence[str] | None = "0016"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("onboarding_step", sa.Column("trace", postgresql.JSONB(), nullable=True))


def downgrade() -> None:
    op.drop_column("onboarding_step", "trace")
