"""Row level security, visibility function, closure rebuild, grants.

Every tenant table: RLS ENABLED and FORCED (owner included); policy tenant_id = app.tenant_id.
Role-scoped tables get a RESTRICTIVE policy for app_user (the /api/* role) on visible_role_ids().
app_service (the /internal/* role) is tenant-scoped only.

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TENANT_TABLES = (
    "archetype_mapping",
    "audit_log",
    "card_rejection",
    "department",
    "feedback",
    "feedback_rule",
    "idempotency_key",
    "initiative",
    "insight_card",
    "llm_call_log",
    "metric",
    "metric_snapshot",
    "outcome",
    "person",
    "role_assignment",
    "role_closure",
    "role_metric",
    "role_node",
    "role_summary",
    "rules_config",
    "run",
    "run_step",
    "signal",
    "warehouse_connection",
)
# Cards and everything that reveals a role's findings follow the org-web visibility rules.
ROLE_SCOPED_TABLES = ("insight_card", "initiative", "outcome", "signal", "feedback")
CATALOG_TABLES = ("data_archetype", "sql_template", "role_archetype", "prompt_template")
# Pipeline internals: never readable through a user session.
SERVICE_ONLY_TABLES = ("llm_call_log", "idempotency_key", "card_rejection", "run_step")

FUNCTIONS = (
    """
CREATE FUNCTION app_tenant_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.tenant_id', true), '')::uuid
$$;
""",
    """
CREATE FUNCTION app_person_id() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.person_id', true), '')::uuid
$$;
""",
    """
-- Role nodes whose cards a person may see (spec: Visibility rules; ADR 0005, 0006).
--   admin                 -> every node, unless the tenant hides cards from admins holding no role
--   holder of the CEO node -> every node
--   department head        -> the whole department box
--   anyone else            -> assigned nodes + their descendants inside the same department
--   deny grants            -> the denied node and its subtree are removed
-- Vacant nodes need no special case: their cards stay on the vacant node and the nearest
-- filled ancestor already sees it as a descendant.
CREATE FUNCTION visible_role_ids(p_person uuid) RETURNS SETOF uuid
LANGUAGE sql STABLE AS $$
  WITH me AS (
    SELECT p.app_role, t.hide_cards_from_roleless_admins AS hide
    FROM person p JOIN tenant t ON t.id = p.tenant_id
    WHERE p.id = p_person
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
    WHERE me.app_role = 'admin' AND (NOT me.hide OR EXISTS (SELECT 1 FROM assigned))
    UNION
    SELECT rn.id FROM role_node rn
    WHERE EXISTS (
      SELECT 1 FROM assigned a JOIN role_node r ON r.id = a.role_node_id
      WHERE r.parent_role_id IS NULL AND r.department_id IS NULL
    )
    UNION
    SELECT rn.id
    FROM assigned a
    JOIN department d ON d.head_role_id = a.role_node_id
    JOIN role_node rn ON rn.department_id = d.id
    UNION
    SELECT c.descendant_id
    FROM assigned a
    JOIN role_node r ON r.id = a.role_node_id
    JOIN role_closure c ON c.ancestor_id = a.role_node_id
    JOIN role_node d ON d.id = c.descendant_id
    WHERE d.department_id IS NOT DISTINCT FROM r.department_id
  )
  SELECT id FROM base
  EXCEPT
  SELECT descendant_id FROM denied
$$;
""",
    """
-- Rebuild the closure for one tenant after any org change (called by the org repository).
CREATE FUNCTION rebuild_role_closure(p_tenant uuid) RETURNS void
LANGUAGE sql AS $$
  DELETE FROM role_closure WHERE tenant_id = p_tenant;
  INSERT INTO role_closure (tenant_id, ancestor_id, descendant_id, depth)
  WITH RECURSIVE walk AS (
    SELECT id AS ancestor_id, id AS descendant_id, 0 AS depth
    FROM role_node WHERE tenant_id = p_tenant
    UNION ALL
    SELECT w.ancestor_id, rn.id, w.depth + 1
    FROM walk w JOIN role_node rn ON rn.parent_role_id = w.descendant_id
    WHERE rn.tenant_id = p_tenant
  )
  SELECT p_tenant, ancestor_id, descendant_id, depth FROM walk;
$$;
""",
    """
-- 90-day retention on raw prompts/responses (spec: LLM contract). Called by WF7.
CREATE FUNCTION purge_llm_call_log(p_days integer) RETURNS integer
LANGUAGE sql AS $$
  WITH gone AS (
    DELETE FROM llm_call_log WHERE created_at < now() - make_interval(days => p_days)
    RETURNING 1
  )
  SELECT count(*)::integer FROM gone
$$;
""",
)


def upgrade() -> None:
    for ddl in FUNCTIONS:
        op.execute(ddl)

    op.execute("ALTER TABLE tenant ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE tenant FORCE ROW LEVEL SECURITY")
    op.execute(
        "CREATE POLICY tenant_isolation ON tenant "
        "USING (id = app_tenant_id()) WITH CHECK (id = app_tenant_id())"
    )

    for table in TENANT_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {table} "
            "USING (tenant_id = app_tenant_id()) WITH CHECK (tenant_id = app_tenant_id())"
        )

    for table in ROLE_SCOPED_TABLES:
        op.execute(
            f"CREATE POLICY role_visibility ON {table} AS RESTRICTIVE TO app_user "
            "USING (role_node_id IN (SELECT visible_role_ids(app_person_id())))"
        )

    for table in CATALOG_TABLES:
        op.execute(f"REVOKE INSERT, UPDATE, DELETE ON {table} FROM app_user, app_service")
    for table in SERVICE_ONLY_TABLES:
        op.execute(f"REVOKE ALL ON {table} FROM app_user")
    op.execute("REVOKE UPDATE, DELETE ON audit_log FROM app_user, app_service")
    op.execute("REVOKE ALL ON login_identity FROM app_service")
    op.execute("REVOKE INSERT, UPDATE, DELETE ON login_identity FROM app_user")
    op.execute("REVOKE ALL ON alembic_version FROM app_user, app_service")


def downgrade() -> None:
    for table in (*TENANT_TABLES, "tenant"):
        op.execute(f"DROP POLICY IF EXISTS tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} NO FORCE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")
    for table in ROLE_SCOPED_TABLES:
        op.execute(f"DROP POLICY IF EXISTS role_visibility ON {table}")
    op.execute(
        "DROP FUNCTION IF EXISTS purge_llm_call_log(integer), rebuild_role_closure(uuid), "
        "visible_role_ids(uuid), app_person_id(), app_tenant_id()"
    )
