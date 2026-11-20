"""Outbound pings to n8n webhooks. n8n stays the sequencer: the API only says "something happened",
and the workflow calls back /internal/* with its service token. Best effort: a missed ping is
caught by the workflow's nightly schedule."""

import uuid

import httpx

from app.core.logging import get_logger
from app.core.settings import get_settings

log = get_logger(__name__)
TIMEOUT_S = 5.0


async def _post(path: str, payload: dict[str, str]) -> bool:
    base = get_settings().n8n_webhook_base
    if not base:
        return False
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT_S) as client:
            res = await client.post(f"{base.rstrip('/')}/webhook/{path}", json=payload)
        res.raise_for_status()
        return True
    except httpx.HTTPError as exc:
        log.warning("n8n.ping_failed", path=path, error=str(exc)[:200])
        return False


async def feedback_given(tenant_id: uuid.UUID, feedback_id: uuid.UUID) -> bool:
    """WF5: compile feedback into proposed rules now rather than at the nightly run."""
    return await _post(
        "wf5-feedback", {"tenant_id": str(tenant_id), "feedback_id": str(feedback_id)}
    )


async def run_now(tenant_id: uuid.UUID) -> bool:
    """WF1 for one tenant (POST /api/runs, admin)."""
    return await _post("wf1-weekly-run", {"tenant_id": str(tenant_id)})
