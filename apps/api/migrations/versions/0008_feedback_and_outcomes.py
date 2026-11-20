"""feedback, actions and outcomes: card model, initiative start and exposure, write policies

- insight_card.generated_by: provider/model that wrote the card (shown in the card metadata).
- initiative.started_on and initiative.exposure: the window start, and the card's exposure frozen
  at action time so value captured uses the same scale as the card's impact (ADR 0019).
- app_user may write feedback and initiatives only as itself, feedback rules only as an admin,
  and never outcomes (WF3 writes those through app_service).

Revision ID: 0008
Revises: 0007
Create Date: 2026-10-28 12:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | Sequence[str] | None = "0007"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

IS_ADMIN = (
    "EXISTS (SELECT 1 FROM person WHERE person.id = app_person_id() AND person.app_role = 'admin')"
)


def upgrade() -> None:
    op.add_column("insight_card", sa.Column("generated_by", sa.String(length=120), nullable=True))
    op.add_column(
        "initiative",
        sa.Column("started_on", sa.Date(), server_default=sa.text("current_date"), nullable=False),
    )
    op.add_column(
        "initiative",
        sa.Column("exposure", sa.Numeric(18, 4), server_default=sa.text("1"), nullable=False),
    )

    op.execute(
        "CREATE POLICY own_feedback ON feedback AS RESTRICTIVE FOR INSERT TO app_user "
        "WITH CHECK (person_id = app_person_id())"
    )
    op.execute("REVOKE UPDATE, DELETE ON feedback FROM app_user")
    op.execute(
        "CREATE POLICY own_initiative ON initiative AS RESTRICTIVE FOR INSERT TO app_user "
        "WITH CHECK (owner_person_id = app_person_id())"
    )
    op.execute("REVOKE DELETE ON initiative FROM app_user")
    op.execute(
        "CREATE POLICY admin_update ON feedback_rule AS RESTRICTIVE FOR UPDATE TO app_user "
        f"USING ({IS_ADMIN}) WITH CHECK ({IS_ADMIN})"
    )
    op.execute("REVOKE INSERT, DELETE ON feedback_rule FROM app_user")
    op.execute("REVOKE INSERT, UPDATE, DELETE ON outcome FROM app_user")


def downgrade() -> None:
    op.execute("GRANT INSERT, UPDATE, DELETE ON outcome TO app_user")
    op.execute("GRANT INSERT, DELETE ON feedback_rule TO app_user")
    op.execute("DROP POLICY IF EXISTS admin_update ON feedback_rule")
    op.execute("GRANT DELETE ON initiative TO app_user")
    op.execute("DROP POLICY IF EXISTS own_initiative ON initiative")
    op.execute("GRANT UPDATE, DELETE ON feedback TO app_user")
    op.execute("DROP POLICY IF EXISTS own_feedback ON feedback")
    op.drop_column("initiative", "exposure")
    op.drop_column("initiative", "started_on")
    op.drop_column("insight_card", "generated_by")
