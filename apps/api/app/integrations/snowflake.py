"""The only module that talks to Snowflake.

Real Snowflake: key-pair auth; the private key is read from the vault per call, in memory only.
Local: WAREHOUSE_HOST points the same connector at the fakesnow emulator (any credentials accepted).
"""

import asyncio
import re
import time
from datetime import date, datetime
from decimal import Decimal
from typing import Any

import snowflake.connector
from snowflake.connector import SnowflakeConnection

from app.core.secrets import get_vault
from app.core.settings import get_settings
from app.integrations.warehouse import ConnectionConfig, QueryResult

# Connections whose secret_ref is one of these log in with a token held in the vault.
PAT_REFS = frozenset({"platform/snowflake_pat"})
_SINGLE_SELECT = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)


class UnsafeQuery(ValueError):
    pass


def assert_read_only(sql: str) -> None:
    """Reject anything that is not exactly one SELECT/WITH statement (spec: query service)."""
    body = sql.strip().rstrip(";")
    if ";" in body or not _SINGLE_SELECT.match(body):
        raise UnsafeQuery("only a single SELECT or WITH statement is allowed")


def connect(
    conn: ConnectionConfig, query_tag: str = "", timeout_seconds: int = 300
) -> SnowflakeConnection:
    settings = get_settings()
    kwargs: dict[str, Any] = {
        "account": conn.account,
        "user": conn.user,
        "role": conn.role,
        "warehouse": conn.warehouse,
        "database": conn.database,
        "session_parameters": {
            "QUERY_TAG": query_tag,
            "STATEMENT_TIMEOUT_IN_SECONDS": timeout_seconds,
        },
        "client_session_keep_alive": False,
        "login_timeout": 30,
    }
    if conn.secret_ref in PAT_REFS:  # a programmatic access token: always the real Snowflake
        kwargs |= {
            "authenticator": "PROGRAMMATIC_ACCESS_TOKEN",
            "token": get_vault().get_secret(conn.secret_ref),
        }
    elif settings.warehouse_host and not conn.secret_ref:  # local emulator (no key)
        kwargs |= {
            "host": settings.warehouse_host,
            "port": settings.warehouse_port,
            "protocol": "http",
            "password": "local-emulator",
        }
    else:
        kwargs["private_key"] = get_vault().get_private_key_der(conn.secret_ref)
    return snowflake.connector.connect(**kwargs)


def _jsonable(value: Any) -> Any:
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return (
            value.date().isoformat() if value.time() == datetime.min.time() else value.isoformat()
        )
    if isinstance(value, date):
        return value.isoformat()
    return value


def _run(
    conn: ConnectionConfig,
    sql: str,
    params: dict[str, Any],
    query_tag: str,
    timeout_seconds: int,
    row_cap: int,
) -> QueryResult:
    assert_read_only(sql)
    started = time.perf_counter()
    with connect(conn, query_tag, timeout_seconds) as cx, cx.cursor() as cur:
        cur.execute(sql, params)
        columns = [d[0].lower() for d in cur.description or []]
        raw = cur.fetchmany(row_cap + 1)
    rows = [{c: _jsonable(v) for c, v in zip(columns, r, strict=True)} for r in raw[:row_cap]]
    return QueryResult(columns, rows, time.perf_counter() - started, len(raw) > row_cap)


class SnowflakeWarehouse:
    async def query(
        self,
        conn: ConnectionConfig,
        sql: str,
        params: dict[str, Any],
        query_tag: str,
        timeout_seconds: int,
        row_cap: int,
    ) -> QueryResult:
        return await asyncio.to_thread(_run, conn, sql, params, query_tag, timeout_seconds, row_cap)

    async def ping(self, conn: ConnectionConfig) -> None:
        """Login plus a metadata query; does not resume the warehouse."""

        def _ping() -> None:
            with connect(conn, "formada:health") as cx, cx.cursor() as cur:
                cur.execute("select current_role()")

        await asyncio.to_thread(_ping)
