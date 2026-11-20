"""Console advisor agent kind (ADR 0029)

- agent.kind gains "console": the agent that suggests settings, measures and new agent
  instructions in the console. It only suggests; a person saves.

Revision ID: 0014
Revises: 0013
Create Date: 2026-11-07 15:00:00.000000

"""

from collections.abc import Sequence

from alembic import op

revision: str = "0014"
down_revision: str | Sequence[str] | None = "0013"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KINDS_OLD = "kind IN ('card_writer', 'translator', 'rule_drafter', 'onboarding')"
KINDS_NEW = "kind IN ('card_writer', 'translator', 'rule_drafter', 'onboarding', 'console')"


def upgrade() -> None:
    op.drop_constraint(op.f("ck_agent_kind"), "agent", type_="check")
    op.create_check_constraint(op.f("ck_agent_kind"), "agent", KINDS_NEW)


def downgrade() -> None:
    op.execute("DELETE FROM agent WHERE kind = 'console'")
    op.drop_constraint(op.f("ck_agent_kind"), "agent", type_="check")
    op.create_check_constraint(op.f("ck_agent_kind"), "agent", KINDS_OLD)
