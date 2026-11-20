"""Idempotent execution of internal calls (ADR 0004).

The first call with a key runs and stores its response; replays return the stored response and
write nothing. Only ok/skipped results are stored: a busy result or an exception releases the key
so the caller's retry runs again. A key held longer than the in-flight timeout is taken over
(the previous holder crashed).
"""

import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import delete, select, update
from sqlalchemy.dialects.postgresql import insert

from app.core.db import tenant_tx
from app.models import IdempotencyKey

IN_FLIGHT_TIMEOUT = timedelta(minutes=10)
STORED_STATUSES = ("ok", "skipped")


async def run_once(
    tenant_id: uuid.UUID,
    key: str,
    endpoint: str,
    fn: Callable[[], Awaitable[dict[str, Any]]],
) -> dict[str, Any]:
    now = datetime.now(UTC)
    async with tenant_tx("service", tenant_id) as s:
        claimed = await s.scalar(
            insert(IdempotencyKey)
            .values(tenant_id=tenant_id, key=key, endpoint=endpoint)
            .on_conflict_do_nothing(index_elements=["tenant_id", "key"])
            .returning(IdempotencyKey.id)
        )
        if claimed is None:
            row = await s.scalar(
                select(IdempotencyKey)
                .where(IdempotencyKey.tenant_id == tenant_id, IdempotencyKey.key == key)
                .with_for_update()
            )
            assert row is not None
            if row.response is not None:
                return {**row.response, "replayed": True}
            if now - row.created_at < IN_FLIGHT_TIMEOUT:
                return {"status": "busy", "reason": "same idempotency key in flight"}
            row.created_at = now

    try:
        result = await fn()
    except BaseException:
        await _release(tenant_id, key)
        raise

    if result.get("status") in STORED_STATUSES:
        async with tenant_tx("service", tenant_id) as s:
            await s.execute(
                update(IdempotencyKey)
                .where(IdempotencyKey.tenant_id == tenant_id, IdempotencyKey.key == key)
                .values(response=result, completed_at=datetime.now(UTC))
            )
    else:
        await _release(tenant_id, key)
    return result


async def _release(tenant_id: uuid.UUID, key: str) -> None:
    async with tenant_tx("service", tenant_id) as s:
        await s.execute(
            delete(IdempotencyKey).where(
                IdempotencyKey.tenant_id == tenant_id, IdempotencyKey.key == key
            )
        )
