"""Operational checks: health, run every hour by the scheduler (ADR 0034)."""

from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select, update

from app.core.db import global_tx, tenant_tx
from app.core.logging import get_logger
from app.integrations.snowflake import SnowflakeWarehouse
from app.models import Run, Tenant, WarehouseConnection
from app.repositories import org as org_repo
from app.repositories import pipeline as repo
from app.repositories.runs import STALE_AFTER

log = get_logger(__name__)
XS_CREDITS_PER_SECOND = 1 / 3600  # an XSMALL warehouse burns 1 credit per running hour


async def health(check_connections: bool) -> dict[str, Any]:
    """Per tenant: stale runs -> failed, failed runs in the last 24 h, credit use vs cap,
    LLM log retention purge, and (optionally) a warehouse login check."""
    async with global_tx("service") as s:
        tenants = (await s.scalars(select(Tenant))).all()
    now = datetime.now(UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    report, alerts = [], []
    for t in tenants:
        async with tenant_tx("service", t.id) as s:
            rules = await org_repo.rules(s)
            stale = await s.execute(
                update(Run)
                .where(Run.status == "running", Run.started_at < now - STALE_AFTER)
                .values(status="failed", ended_at=now, error="stale: no finish within 6 hours")
                .returning(Run.id)
            )
            stale_ids = [str(r) for r in stale.scalars()]
            failed_24h = await s.scalar(
                select(func.count()).where(
                    Run.status.in_(("failed", "partial")), Run.started_at > now - timedelta(days=1)
                )
            )
            seconds = await s.scalar(
                select(func.coalesce(func.sum(Run.query_seconds), 0)).where(
                    Run.started_at >= month_start
                )
            )
            wc = await s.scalar(select(WarehouseConnection))
            purged = await s.scalar(select(func.purge_llm_call_log(rules.llm_log_retention_days)))
            conn = await repo.connection(s)
        credits = float(seconds or 0) * XS_CREDITS_PER_SECOND
        cap = float(wc.monthly_credit_cap) if wc else None
        entry: dict[str, Any] = {
            "tenant_id": str(t.id),
            "name": t.name,
            "stale_runs_failed": stale_ids,
            "failed_runs_24h": int(failed_24h or 0),
            "estimated_credits_month": round(credits, 4),
            "credit_cap": cap,
            "llm_logs_purged": int(purged or 0),
        }
        if check_connections and conn is not None:
            try:
                await SnowflakeWarehouse().ping(conn)
                entry["connection"] = "ok"
            except Exception as exc:
                entry["connection"] = f"failed: {str(exc)[:200]}"
                alerts.append(f"{t.name}: warehouse connection failed")
        if entry["failed_runs_24h"]:
            alerts.append(f"{t.name}: {entry['failed_runs_24h']} failed/partial runs in 24h")
        if cap and credits >= 0.8 * cap:
            alerts.append(f"{t.name}: credit use at {credits / cap:.0%} of cap")
        report.append(entry)
    if alerts:
        log.warning("health.alerts", alerts=alerts)
    return {"status": "ok", "healthy": not alerts, "alerts": alerts, "tenants": report}
