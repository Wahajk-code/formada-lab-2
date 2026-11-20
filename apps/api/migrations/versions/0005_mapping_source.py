"""archetype_mapping.table_name -> source (TEXT): a mapping can be a SELECT joining tables.

Revision ID: 0005
Revises: 0004
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.alter_column("archetype_mapping", "table_name", new_column_name="source", type_=sa.Text())


def downgrade() -> None:
    op.alter_column(
        "archetype_mapping", "source", new_column_name="table_name", type_=sa.String(300)
    )
