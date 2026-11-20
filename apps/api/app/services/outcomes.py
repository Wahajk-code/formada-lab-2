"""WF3 remeasure: midpoint and end measurements of in-progress initiatives (spec: Actioning and
outcomes; ADR 0019). Same template, params and mappings as the card's metric; the period end is
the measurement date, so a late run still measures the window it was due for."""

import uuid
from collections import defaultdict
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from app.core.db import tenant_tx
from app.core.logging import get_logger
from app.domain import outcomes as rules_out
from app.domain.templates import TemplateError, check_contract, render
from app.integrations.snowflake import SnowflakeWarehouse
from app.integrations.warehouse import WarehouseClient
from app.models import Initiative, InsightCard, Metric, Outcome, Run, Tenant
from app.repositories import org as org_repo
from app.repositories import pipeline as repo
from app.services.runs import step

log = get_logger(__name__)


async def measure(
    tenant_id: uuid.UUID, run_id: uuid.UUID, warehouse: WarehouseClient | None = None
) -> dict[str, Any]:
    warehouse = warehouse or SnowflakeWarehouse()
    async with step(tenant_id, run_id, None, "outcomes_measure") as outcome:
        async with tenant_tx("service", tenant_id) as s:
            run = await s.get(Run, run_id)
            tenant = await s.get(Tenant, tenant_id)
            assert run is not None and tenant is not None
            rules = await org_repo.rules(s)
            conn = await repo.connection(s)
            maps = await repo.mappings(s)
            rows = (
                await s.execute(
                    select(Initiative, InsightCard, Metric)
                    .join(InsightCard, InsightCard.id == Initiative.card_id)
                    .join(Metric, Metric.id == Initiative.metric_id)
                    .where(Initiative.status == "in_progress")
                )
            ).all()
            taken: dict[uuid.UUID, set[str]] = defaultdict(set)
            for o in await s.scalars(
                select(Outcome).where(Outcome.initiative_id.in_([i.id for i, _, _ in rows]))
            ):
                taken[o.initiative_id].add(o.kind)
            today = (run.scheduled_for or datetime.now(UTC)).date()
            work = []
            for ini, card, metric in rows:
                for due in rules_out.due_measurements(
                    ini.started_on, ini.window_days, taken[ini.id], today, rules
                ):
                    tpl = await repo.template(
                        s, metric.sql_template_key, metric.sql_template_version
                    )
                    work.append((ini.id, card.evidence.get("entity"), metric, tpl, due))
        if not work:
            outcome.update(status="skipped", reason="no measurement due")
            return outcome
        if conn is None:
            outcome.update(status="skipped", reason="no warehouse connection")
            return outcome

        # One query per (metric, measurement date), shared by the initiatives that need it.
        series_cache: dict[tuple[uuid.UUID, date], dict[str, list[float]]] = {}
        measured, failed = [], []
        for ini_id, entity, metric, tpl, due in work:
            key = (metric.id, due.on)
            try:
                if key not in series_cache:
                    if tpl is None:
                        raise TemplateError(f"template {metric.sql_template_key} missing")
                    sql = render(tpl.sql, tpl.aliases, maps)
                    check_contract(sql)
                    params = {
                        **{k: v.get("default") for k, v in tpl.params_schema.items()},
                        **metric.params,
                        "period_end": due.on,
                        "row_cap": rules.query_row_cap,
                    }
                    result = await warehouse.query(
                        conn, sql, params,
                        f"formada:{tenant_id}:{run_id}:remeasure:{metric.key}",
                        rules.query_timeout_seconds, rules.query_row_cap,
                    )  # fmt: skip
                    by_entity: dict[str, list[tuple[str, float]]] = defaultdict(list)
                    for r in result.rows:
                        by_entity[str(r["entity"])].append((str(r["period_start"]), r["value"]))
                    series_cache[key] = {
                        e: [float(v) for _, v in sorted(pts)] for e, pts in by_entity.items()
                    }
                value = rules_out.level(series_cache[key].get(str(entity), []), rules.recent_weeks)
                if value is None:
                    raise LookupError(f"{entity!r} not in the {metric.key} result")
            except Exception as exc:  # one initiative failing must not stop the others
                failed.append({"initiative_id": str(ini_id), "error": str(exc)[:300]})
                log.warning("outcome.failed", initiative_id=str(ini_id), error=str(exc)[:300])
                continue
            measured.append((ini_id, metric, due, value))

        done = 0
        async with tenant_tx("service", tenant_id) as s:
            for ini_id, metric, due, value in measured:
                row = await s.get(Initiative, ini_id)
                assert row is not None
                delta, captured = rules_out.captured(
                    float(row.baseline_value),
                    value,
                    metric.higher_is_better,
                    float(metric.unit_value),
                    float(row.exposure),
                )
                s.add(
                    Outcome(
                        tenant_id=tenant_id,
                        initiative_id=row.id,
                        role_node_id=row.role_node_id,
                        kind=due.kind,
                        measured_at=datetime.combine(due.on, datetime.min.time(), UTC),
                        value=Decimal(str(round(value, 4))),
                        delta_vs_baseline=Decimal(str(delta)),
                        value_captured=Decimal(str(captured)),
                        currency=tenant.currency,
                    )
                )
                if due.kind == "end":
                    row.status = "done"  # the owner is then asked: keep doing this, or stop
                    done += 1
        outcome.update(
            measured=len(measured),
            failed=failed,
            initiatives_done=done,
            status="ok" if measured or not failed else "failed",
        )
        if failed and not measured:
            outcome["error"] = failed[0]["error"]
    return outcome
