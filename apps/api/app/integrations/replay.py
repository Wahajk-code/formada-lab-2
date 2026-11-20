"""Lab mode warehouse: there is no live Snowflake. The lab replays snapshots saved from a real run
(profile, mapping checks, dry runs) and calls the Claude API live for everything else.

A query that would need the warehouse is refused with a plain message; callers that can fall back
to a saved result do so (see services/onboarding.py, `lab_mode`).
"""

from typing import Any

from app.integrations.warehouse import ConnectionConfig, QueryResult


class LabNoWarehouse(RuntimeError):
    """Raised for any live query in lab mode."""


class LabReplayWarehouse:
    async def query(
        self,
        conn: ConnectionConfig,
        sql: str,
        params: dict[str, Any],
        query_tag: str,
        timeout_seconds: int,
        row_cap: int,
    ) -> QueryResult:
        raise LabNoWarehouse(
            "the lab has no live warehouse: it replays saved snapshots. "
            "Live queries run in a real workspace."
        )

    async def ping(self, conn: ConnectionConfig) -> None:
        return None
