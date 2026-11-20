"""in-app sign-in: passwords, lockout, sign out everywhere, reset links (ADR 0023)

- login_identity and staff_user gain password_hash, failed_attempts, locked_until,
  token_version (bumped to revoke every session) and last_login_at; staff_user deactivated_at.
- password_reset: platform table of single-use reset links (hash only).
- login_identity becomes service-only: the web session (app_user) never reads password hashes.
  Sign-in, invites and resets run through the service connection.

Revision ID: 0010
Revises: 0009
Create Date: 2026-10-30 10:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0010"
down_revision: str | Sequence[str] | None = "0009"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

AUTH_COLUMNS = (
    ("password_hash", sa.String(200), None),
    ("failed_attempts", sa.Integer(), sa.text("0")),
    ("locked_until", sa.DateTime(timezone=True), None),
    ("token_version", sa.Integer(), sa.text("0")),
    ("last_login_at", sa.DateTime(timezone=True), None),
)


def upgrade() -> None:
    for table in ("login_identity", "staff_user"):
        for name, type_, default in AUTH_COLUMNS:
            op.add_column(
                table,
                sa.Column(name, type_, server_default=default, nullable=default is None),
            )
    op.add_column("staff_user", sa.Column("deactivated_at", sa.DateTime(timezone=True)))

    op.create_table(
        "password_reset",
        sa.Column(
            "id", postgresql.UUID(as_uuid=True), server_default=sa.text("gen_random_uuid()"),
            primary_key=True,
        ),
        sa.Column("kind", sa.String(10), nullable=False),
        sa.Column("subject_id", postgresql.UUID(as_uuid=True), nullable=False, index=True),
        sa.Column("token_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.CheckConstraint("kind IN ('person', 'staff')", name=op.f("ck_password_reset_kind")),
    )  # fmt: skip
    op.execute("REVOKE ALL ON password_reset FROM app_user")
    op.execute("REVOKE ALL ON login_identity FROM app_user")
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON login_identity TO app_service")


def downgrade() -> None:
    op.execute("REVOKE UPDATE ON login_identity FROM app_service")
    op.execute("GRANT SELECT ON login_identity TO app_user")
    op.drop_table("password_reset")
    op.drop_column("staff_user", "deactivated_at")
    for table in ("login_identity", "staff_user"):
        for name, _type, _default in AUTH_COLUMNS:
            op.drop_column(table, name)
