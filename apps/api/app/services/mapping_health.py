"""Mapping health: at the start of a weekly run, re-measure every approved mapping on the warehouse
and compare it with how it looked when the team approved it.

A customer's pipeline can change under a frozen mapping (rows repeat after a re-load, a column goes
empty, a location code changes). Without this check the run would compute metrics on it and the
weak signal would reach a card weeks later. The same measurements as onboarding are used
(`services.onboarding.measure_mapping`), so a number means the same thing in both places.

Never blocks a run: the result is stored in the run step and logged, and the console shows it.
"""

import uuid
from typing import Any

from app.core.errors import Conflict
from app.domain import onboarding as ob
from app.domain.templates import Mapping
from app.integrations.warehouse import ConnectionConfig, WarehouseClient
from app.services import onboarding as onboarding_service

SEVERITY = {"ok": 0, "warn": 1, "fail": 2}


async def _baseline(tenant_id: uuid.UUID) -> dict[str, dict[str, Any]]:
    """What each archetype measured when the team approved the mapping step."""
    try:
        step = await onboarding_service._latest(tenant_id, "mapping", approved=True)
    except Conflict:  # a workspace set up by hand has no approved step to compare with
        return {}
    return dict((step.checks or {}).get("archetypes") or {})


def _source_select(source: str) -> str:
    text = source.strip().rstrip(";")
    return text if ob.SINGLE_SELECT.match(text) else f"select * from {text}"


async def check(
    wh: WarehouseClient,
    conn: ConnectionConfig,
    tenant_id: uuid.UUID,
    maps: dict[str, Mapping],
    rules: Any,
) -> dict[str, Any]:
    fields_of = {
        a["archetype"]: [f["field"] for f in a["fields"]]
        for a in await onboarding_service._archetypes()
    }
    baseline = await _baseline(tenant_id)
    results: list[dict[str, Any]] = []
    for name, mapping in sorted(maps.items()):
        fields = fields_of.get(name)
        if not fields:
            continue
        before = baseline.get(name)
        empty_then = {f["field"] for f in (before or {}).get("fills", []) if f["fill_pct"] == 0}
        try:
            live, entry = await onboarding_service.measure_mapping(
                wh, conn, rules, name, _source_select(mapping.source), fields, empty_then
            )
            results.append(
                ob.judge_mapping_health(
                    name, before, entry, live,
                    rules.mapping_health_rows_change_pct, rules.mapping_health_fill_drop_pts,
                )
            )  # fmt: skip
        except Exception as exc:  # the warehouse refused the source: the mapping no longer works
            results.append(
                {"archetype": name, "status": "fail", "rows": 0,
                 "issues": [f"{name}: the warehouse refused the source: {str(exc)[:300]}"]}
            )  # fmt: skip
    worst = max((r["status"] for r in results), key=SEVERITY.__getitem__, default="ok")
    return {"status": worst, "archetypes": results}
