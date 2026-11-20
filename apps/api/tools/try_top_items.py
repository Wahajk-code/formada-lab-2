"""Local check: run each v2 template's top_items query for one workspace (no writes).
python -m tools.try_top_items <workspace_id>"""

import asyncio
import sys
import uuid
from datetime import UTC, datetime

from sqlalchemy import select

from app.core.db import global_tx, tenant_tx
from app.domain import runs as run_rules
from app.domain.templates import check_contract, render
from app.integrations.snowflake import SnowflakeWarehouse
from app.models import SqlTemplate
from app.repositories import org as org_repo
from app.repositories import pipeline as repo


async def main(ws: uuid.UUID) -> None:
    async with tenant_tx("service", ws) as s:
        conn = await repo.connection(s)
        maps = await repo.mappings(s)
        rules = await org_repo.rules(s)
    async with global_tx("service") as s:
        tpls = (await s.scalars(select(SqlTemplate).where(SqlTemplate.version == 2))).all()
    wh = SnowflakeWarehouse()
    period_end = run_rules.period_end(datetime.now(UTC), "weekly")
    for t in tpls:
        spec = t.drivers.get("top_items")
        if not spec:
            continue
        sql = render(spec["sql"], t.aliases, maps)
        check_contract(sql)
        params = {
            **{k: v.get("default") for k, v in t.params_schema.items()},
            "period_end": period_end,
            "row_cap": 1000,
            "top_n": rules.top_items_per_problem,
        }
        r = await wh.query(conn, sql, params, "try_top_items", 120, 1000)
        entities = {row["entity"] for row in r.rows}
        print(f"\n== {t.key} v2: {len(r.rows)} rows, {len(entities)} locations, {r.seconds:.2f}s")
        for row in r.rows[:4]:
            print("  ", dict(row))


if __name__ == "__main__":
    asyncio.run(main(uuid.UUID(sys.argv[1])))
