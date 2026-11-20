"""internal console, client access control, AI agents (ADR 0020, 0021, 0022)

- Platform tables (no tenant, no RLS): staff_user, system_config, config_change, agent,
  agent_prompt. Written only through the service connection (the console runs on it).
- Workspace roles owner | admin | member; person.deactivated_at; invite (tenant, RLS).
- card_translation (tenant, role-scoped RLS); agent columns on cards and LLM logs;
  feedback_rule.suggested_text.
- "Admin" policies now mean owner or admin. Client admins may manage people, assignments,
  invites and workspace settings; nobody else may write them through a user session.
- The service role gains the writes the console needs (LLM choice, overrides, identities).

Revision ID: 0009
Revises: 0008
Create Date: 2026-10-28 18:00:00.000000

"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0009"
down_revision: str | Sequence[str] | None = "0008"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

IS_ADMIN = (
    "EXISTS (SELECT 1 FROM person WHERE person.id = app_person_id() "
    "AND person.app_role IN ('owner', 'admin'))"
)
UUID = postgresql.UUID(as_uuid=True)
NOW = sa.text("now()")

VISIBLE_ROLE_IDS = """
CREATE OR REPLACE FUNCTION visible_role_ids(p_person uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT p.app_role, t.hide_cards_from_roleless_admins AS hide
    FROM person p JOIN tenant t ON t.id = p.tenant_id
    WHERE p.id = p_person AND p.deactivated_at IS NULL
  ),
  assigned AS (
    SELECT ra.role_node_id
    FROM role_assignment ra
    WHERE ra.person_id = p_person AND ra.grant_effect = 'allow'
  ),
  denied AS (
    SELECT c.descendant_id
    FROM role_assignment ra
    JOIN role_closure c ON c.ancestor_id = ra.role_node_id
    WHERE ra.person_id = p_person AND ra.grant_effect = 'deny'
  ),
  base AS (
    SELECT rn.id FROM role_node rn, me
    WHERE me.app_role IN ('owner', 'admin') AND (NOT me.hide OR EXISTS (SELECT 1 FROM assigned))
    UNION
    SELECT rn.id FROM role_node rn
    WHERE EXISTS (SELECT 1 FROM me) AND EXISTS (
      SELECT 1 FROM assigned a JOIN role_node r ON r.id = a.role_node_id
      WHERE r.parent_role_id IS NULL AND r.department_id IS NULL
    )
    UNION
    SELECT rn.id
    FROM assigned a
    JOIN department d ON d.head_role_id = a.role_node_id
    JOIN role_node rn ON rn.department_id = d.id
    WHERE EXISTS (SELECT 1 FROM me)
    UNION
    SELECT c.descendant_id
    FROM assigned a
    JOIN role_node r ON r.id = a.role_node_id
    JOIN role_closure c ON c.ancestor_id = a.role_node_id
    JOIN role_node d ON d.id = c.descendant_id
    WHERE d.department_id IS NOT DISTINCT FROM r.department_id AND EXISTS (SELECT 1 FROM me)
  )
  SELECT id FROM base
  EXCEPT
  SELECT descendant_id FROM denied
$$;
"""


def _tenant_rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"CREATE POLICY tenant_isolation ON {table} "
        "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())"
    )


def _admin_writes(table: str) -> None:
    """Restrictive: through a user session, only owners and admins may write this table."""
    for cmd in ("INSERT", "UPDATE", "DELETE"):
        check = f"WITH CHECK ({IS_ADMIN})" if cmd != "DELETE" else ""
        using = f"USING ({IS_ADMIN})" if cmd != "INSERT" else ""
        op.execute(
            f"CREATE POLICY admin_{cmd.lower()} ON {table} AS RESTRICTIVE FOR {cmd} TO app_user "
            f"{using} {check}"
        )


def upgrade() -> None:
    # ---- platform tables ------------------------------------------------------------------
    op.create_table(
        "staff_user",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("email", sa.String(320), nullable=False, unique=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("staff_role", sa.String(10), nullable=False, server_default="admin"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint("staff_role IN ('admin', 'developer')", name=op.f("ck_staff_user_staff_role")),
    )
    op.create_table(
        "system_config",
        sa.Column("key", sa.String(80), primary_key=True),
        sa.Column("value", postgresql.JSONB(), nullable=False),
        sa.Column("updated_by", sa.String(320), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
    )
    op.create_table(
        "config_change",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("workspace_id", UUID, sa.ForeignKey("tenant.id", ondelete="CASCADE"), index=True),
        sa.Column("scope", sa.String(20), nullable=False),
        sa.Column("key", sa.String(200), nullable=False),
        sa.Column("old_value", postgresql.JSONB()),
        sa.Column("new_value", postgresql.JSONB()),
        sa.Column("actor", sa.String(320), nullable=False),
        sa.Column("at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
    )
    op.create_table(
        "agent",
        sa.Column("key", sa.String(80), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False),
        sa.Column("kind", sa.String(20), nullable=False),
        sa.Column("playbook", sa.String(50)),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("active_version", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("model_override", sa.String(120)),
        sa.Column("use_examples", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint(
            "kind IN ('card_writer', 'translator', 'rule_drafter')", name=op.f("ck_agent_kind")
        ),
    )
    op.create_table(
        "agent_prompt",
        sa.Column(
            "agent_key", sa.String(80), sa.ForeignKey("agent.key", ondelete="CASCADE"),
            primary_key=True,
        ),
        sa.Column("version", sa.Integer(), primary_key=True),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("notes", sa.Text(), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(320), nullable=False, server_default="catalog"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
    )  # fmt: skip
    for table in ("staff_user", "config_change"):
        op.execute(f"REVOKE ALL ON {table} FROM app_user")
    op.execute("REVOKE UPDATE, DELETE ON config_change FROM app_service")
    for table in ("system_config", "agent", "agent_prompt"):
        op.execute(f"REVOKE INSERT, UPDATE, DELETE ON {table} FROM app_user")
    op.execute("REVOKE UPDATE, DELETE ON agent_prompt FROM app_service")  # versions are immutable

    # ---- columns -----------------------------------------------------------------------------
    op.add_column("insight_card", sa.Column("agent_key", sa.String(80)))
    op.add_column("insight_card", sa.Column("agent_version", sa.Integer()))
    op.add_column("llm_call_log", sa.Column("agent_key", sa.String(80)))
    op.add_column("llm_call_log", sa.Column("agent_version", sa.Integer()))
    op.add_column("feedback_rule", sa.Column("suggested_text", sa.Text()))
    op.add_column("person", sa.Column("deactivated_at", sa.DateTime(timezone=True)))
    op.drop_constraint(op.f("ck_person_app_role"), "person", type_="check")
    op.create_check_constraint(
        op.f("ck_person_app_role"), "person", "app_role IN ('owner', 'admin', 'member')"
    )

    # ---- tenant tables -----------------------------------------------------------------------
    op.create_table(
        "invite",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("tenant_id", UUID, sa.ForeignKey("tenant.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("app_role", sa.String(10), nullable=False, server_default="member"),
        sa.Column("locale", sa.String(2), nullable=False, server_default="en"),
        sa.Column("assignments", postgresql.JSONB(), nullable=False, server_default="[]"),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("status", sa.String(10), nullable=False, server_default="pending"),
        sa.Column("invited_by", UUID, sa.ForeignKey("person.id", ondelete="SET NULL")),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.CheckConstraint("app_role IN ('owner', 'admin', 'member')", name=op.f("ck_invite_app_role")),
        sa.CheckConstraint("status IN ('pending', 'accepted', 'revoked')", name=op.f("ck_invite_status")),
    )  # fmt: skip
    op.create_index("ix_invite_token_hash", "invite", ["token_hash"], unique=True)
    _tenant_rls("invite")
    _admin_writes("invite")
    op.execute(f"CREATE POLICY admin_select ON invite AS RESTRICTIVE FOR SELECT TO app_user USING ({IS_ADMIN})")

    op.create_table(
        "card_translation",
        sa.Column("id", UUID, server_default=sa.text("gen_random_uuid()"), primary_key=True),
        sa.Column("tenant_id", UUID, sa.ForeignKey("tenant.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("card_id", UUID, sa.ForeignKey("insight_card.id", ondelete="CASCADE"), nullable=False, index=True),
        sa.Column("role_node_id", UUID, sa.ForeignKey("role_node.id", ondelete="CASCADE"), nullable=False),
        sa.Column("language", sa.String(2), nullable=False),
        sa.Column("title", sa.String(120), nullable=False),
        sa.Column("what", sa.Text(), nullable=False),
        sa.Column("so_what", sa.Text(), nullable=False),
        sa.Column("now_what", sa.Text(), nullable=False),
        sa.Column("generated_by", sa.String(160), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=NOW, nullable=False),
        sa.UniqueConstraint("card_id", "language", name="uq_card_translation_card_id"),
        sa.CheckConstraint("language IN ('en', 'fr')", name=op.f("ck_card_translation_language")),
    )  # fmt: skip
    _tenant_rls("card_translation")
    op.execute(
        "CREATE POLICY role_visibility ON card_translation AS RESTRICTIVE TO app_user "
        "USING (role_node_id IN (SELECT visible_role_ids(app_person_id())))"
    )
    op.execute("REVOKE UPDATE, DELETE ON card_translation FROM app_user")

    # ---- admin now means owner or admin --------------------------------------------------------
    op.execute(VISIBLE_ROLE_IDS)
    for table, policy in (("llm_setting", "admin_insert"), ("llm_setting", "admin_update"),
                          ("feedback_rule", "admin_update")):  # fmt: skip
        op.execute(f"DROP POLICY IF EXISTS {policy} ON {table}")
    op.execute(
        f"CREATE POLICY admin_insert ON llm_setting AS RESTRICTIVE FOR INSERT TO app_user WITH CHECK ({IS_ADMIN})"
    )
    op.execute(
        f"CREATE POLICY admin_update ON llm_setting AS RESTRICTIVE FOR UPDATE TO app_user USING ({IS_ADMIN}) WITH CHECK ({IS_ADMIN})"
    )
    op.execute(
        f"CREATE POLICY admin_update ON feedback_rule AS RESTRICTIVE FOR UPDATE TO app_user USING ({IS_ADMIN}) WITH CHECK ({IS_ADMIN})"
    )
    # People, assignments and workspace settings: owners and admins only (the API also checks).
    _admin_writes("role_assignment")
    _admin_writes("person")
    op.execute(
        f"CREATE POLICY admin_update ON tenant AS RESTRICTIVE FOR UPDATE TO app_user USING ({IS_ADMIN}) WITH CHECK ({IS_ADMIN})"
    )
    op.execute("REVOKE INSERT, DELETE ON tenant FROM app_user")

    # ---- what the console (service connection) may write -----------------------------------------
    op.execute("GRANT INSERT, UPDATE ON llm_setting TO app_service")
    op.execute("GRANT INSERT, DELETE ON login_identity TO app_service")
    op.execute("GRANT SELECT ON login_identity TO app_service")


def downgrade() -> None:
    op.execute("REVOKE INSERT, DELETE, SELECT ON login_identity FROM app_service")
    op.execute("REVOKE INSERT, UPDATE ON llm_setting FROM app_service")
    op.execute("GRANT INSERT, DELETE ON tenant TO app_user")
    op.execute("DROP POLICY IF EXISTS admin_update ON tenant")
    for table in ("role_assignment", "person"):
        for cmd in ("insert", "update", "delete"):
            op.execute(f"DROP POLICY IF EXISTS admin_{cmd} ON {table}")
    op.drop_table("card_translation")
    op.drop_table("invite")
    op.drop_constraint(op.f("ck_person_app_role"), "person", type_="check")
    op.execute("UPDATE person SET app_role = 'admin' WHERE app_role = 'owner'")
    op.create_check_constraint(op.f("ck_person_app_role"), "person", "app_role IN ('admin', 'member')")
    op.drop_column("person", "deactivated_at")
    op.drop_column("feedback_rule", "suggested_text")
    for table in ("llm_call_log", "insight_card"):
        op.drop_column(table, "agent_version")
        op.drop_column(table, "agent_key")
    for table in ("agent_prompt", "agent", "config_change", "system_config", "staff_user"):
        op.drop_table(table)
