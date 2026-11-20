"""Copy a finished workspace from a source database into the lab database (schema and plans only:
the data guide, the mapping, the org and the metric plan; never warehouse rows).

  SRC_URL=postgresql+asyncpg://app_owner:...@localhost:55432/formada \
  DST_URL=postgresql+asyncpg://app_owner:...@NEON_HOST/neondb \
  TENANT_ID=<uuid of the finished workspace> LAB_NAME="Customer (lab snapshot)" \
  python lab/load_snapshot.py

The copied discovery, mapping, org and metrics proposals arrive as "proposed", so reviewers can edit,
re-run and lock them. The connection is marked tested; there is no live warehouse in the lab.
"""
import asyncio
import os
import uuid

from sqlalchemy import MetaData, delete, insert, select, text
from sqlalchemy.ext.asyncio import create_async_engine

TABLES = ["tenant", "llm_setting", "warehouse_connection", "department", "role_node", "role_closure",
          "archetype_mapping", "onboarding_step"]
STEPS = ("discovery", "mapping", "org", "metrics")


async def main() -> None:
    tenant_id = uuid.UUID(os.environ["TENANT_ID"])
    name = os.environ.get("LAB_NAME", "Lab snapshot")
    src = create_async_engine(os.environ["SRC_URL"])
    dst = create_async_engine(os.environ["DST_URL"])
    async with src.connect() as cx:
        meta = MetaData()
        await cx.run_sync(lambda c: meta.reflect(c, only=TABLES))
        await cx.execute(text("select set_config('app.tenant_id', :t, false)"), {"t": str(tenant_id)})
        data: dict[str, list[dict]] = {}
        for t in TABLES:
            table = meta.tables[t]
            key = table.c.id if t == "tenant" else table.c.tenant_id
            q = select(table).where(key == tenant_id)
            if t == "onboarding_step":
                q = q.where(table.c.step.in_(STEPS), table.c.status.in_(("proposed", "approved", "superseded")))
            data[t] = [dict(r._mapping) for r in (await cx.execute(q)).all()]
    print({t: len(v) for t, v in data.items()})
    async with dst.begin() as cx:
        meta2 = MetaData()
        await cx.run_sync(lambda c: meta2.reflect(c, only=TABLES))
        await cx.execute(text("select set_config('app.tenant_id', :t, true)"), {"t": str(tenant_id)})
        heads: dict = {}
        parents: dict = {}
        await cx.execute(delete(meta2.tables["tenant"]).where(meta2.tables["tenant"].c.id == tenant_id))
        for t in TABLES:
            rows = data[t]
            if not rows:
                continue
            if t == "tenant":
                rows[0]["name"] = name
                rows[0]["lifecycle"] = "onboarding"
            if t == "warehouse_connection":
                for r in rows:
                    r.update(status="ok", account_identifier="lab-snapshot", user_name="LAB", secret_ref="")
            if t == "onboarding_step":  # newest proposal per step is open; older ones are history
                seen: set[str] = set()
                for r in sorted(rows, key=lambda x: x["created_at"], reverse=True):
                    r["status"] = "superseded" if r["step"] in seen else "proposed"
                    seen.add(r["step"])
            if t == "department":  # departments and roles point at each other: link heads afterwards
                heads = {r["id"]: r["head_role_id"] for r in rows}
                for r in rows:
                    r["head_role_id"] = None
            if t == "role_node":  # a role points at its parent: link parents afterwards
                parents = {r["id"]: r["parent_role_id"] for r in rows}
                for r in rows:
                    r["parent_role_id"] = None
            await cx.execute(insert(meta2.tables[t]), rows)
        node = meta2.tables["role_node"]
        for node_id, parent in parents.items():
            await cx.execute(node.update().where(node.c.id == node_id).values(parent_role_id=parent))
        dep = meta2.tables["department"]
        for dep_id, head in heads.items():
            await cx.execute(dep.update().where(dep.c.id == dep_id).values(head_role_id=head))
    print("loaded", name, tenant_id)


asyncio.run(main())
