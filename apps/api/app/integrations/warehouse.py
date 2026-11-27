"""WarehouseClient: the only way services reach a customer warehouse."""

from dataclasses import dataclass
from typing import Any, Protocol


@dataclass(frozen=True)
class ConnectionConfig:
    account: str
    user: str
    role: str
    warehouse: str
    database: str
    secret_ref: str
    # What Discovery may profile: a schema ("GOLD") or one table ("GOLD.DIM_CALENDAR"). Empty: all.
    schemas: tuple[str, ...] = ()


@dataclass(frozen=True)
class QueryResult:
    columns: list[str]
    rows: list[dict[str, Any]]
    seconds: float
    truncated: bool


class WarehouseClient(Protocol):
    async def query(
        self,
        conn: ConnectionConfig,
        sql: str,
        params: dict[str, Any],
        query_tag: str,
        timeout_seconds: int,
        row_cap: int,
    ) -> QueryResult: ...

    async def ping(self, conn: ConnectionConfig) -> None: ...
