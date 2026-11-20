"""Seed the catalog and the demo tenants. Idempotent: ids are deterministic (uuid5).

python -m app.cli.seed            # load catalog, create missing tenants
python -m app.cli.seed --reset    # drop and recreate the demo tenants
"""

import argparse
import asyncio
import uuid
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import global_tx, tenant_tx
from app.core.logging import configure_logging, get_logger
from app.core.passwords import hash_password
from app.core.settings import get_settings
from app.models import (
    ArchetypeMapping,
    Department,
    Feedback,
    Initiative,
    InsightCard,
    LoginIdentity,
    Metric,
    Person,
    RoleArchetype,
    RoleAssignment,
    RoleMetric,
    RoleNode,
    StaffUser,
    Tenant,
    WarehouseConnection,
)
from app.services.catalog_loader import load_catalog

log = get_logger(__name__)
NAMESPACE = uuid.UUID("7c0f1a52-3c9b-4f3e-9a51-6a3b2d8e0c11")
TENANTS_FILE = Path(__file__).resolve().parents[2] / "seed" / "tenants.yaml"
STAFF_FILE = TENANTS_FILE.with_name("staff.yaml")


def _seed_hash() -> str | None:
    """Demo accounts sign in with SEED_USER_PASSWORD from .env (never committed). Unset: no
    password, and only the local dev shortcuts can sign them in."""
    password = get_settings().seed_user_password
    return hash_password(password) if password else None


def sid(*parts: str) -> uuid.UUID:
    """Deterministic id, so tests and docs can reference seeded rows."""
    return uuid.uuid5(NAMESPACE, ":".join(parts))


async def _seed_tenant(spec: dict[str, Any], archetypes: dict[str, dict[str, Any]]) -> None:
    slug = spec["slug"]
    tenant_id = sid(slug)
    async with tenant_tx("owner", tenant_id) as s:
        s.add(
            Tenant(
                id=tenant_id,
                name=spec["name"],
                locale=spec["locale"],
                timezone=spec["timezone"],
                currency=spec["currency"],
            )
        )
        # No ORM relationships, so the unit of work cannot order inserts: flush parents first.
        await s.flush()
        people = {p["email"]: sid(slug, "person", p["email"]) for p in spec["people"]}
        for p in spec["people"]:
            s.add(
                Person(
                    id=people[p["email"]],
                    tenant_id=tenant_id,
                    email=p["email"],
                    name=p["name"],
                    app_role=p.get("app_role", "member"),
                    locale=p["locale"],
                )
            )
        departments = {d["name"]: sid(slug, "department", d["name"]) for d in spec["departments"]}
        for d in spec["departments"]:
            s.add(
                Department(
                    id=departments[d["name"]],
                    tenant_id=tenant_id,
                    name=d["name"],
                    playbook=d["playbook"],
                    sort_order=d["sort_order"],
                )
            )
        await s.flush()

        roles = {r["ref"]: sid(slug, "role", r["ref"]) for r in spec["roles"]}
        for r in spec["roles"]:  # parents are listed before children
            archetype = archetypes[r["archetype"]]
            s.add(
                RoleNode(
                    id=roles[r["ref"]],
                    tenant_id=tenant_id,
                    department_id=departments.get(r.get("department", "")),
                    parent_role_id=roles.get(r.get("parent", "")),
                    title=r["title"],
                    role_archetype_key=r["archetype"],
                    holder_type=r.get("holder_type", "human"),
                    decisions_owned=archetype["decisions_owned"],
                    decisions_forbidden=archetype["decisions_forbidden"],
                    kpi_notes=archetype["kpi_notes"],
                    cadence=r.get("cadence", "weekly"),
                    language=r.get("language", spec["locale"]),
                )
            )
            await s.flush()
            if holder := r.get("holder"):
                s.add(
                    RoleAssignment(
                        tenant_id=tenant_id,
                        person_id=people[holder],
                        role_node_id=roles[r["ref"]],
                        permission="owner",
                        is_primary=True,
                    )
                )
        for d in spec["departments"]:
            dept = await s.get(Department, departments[d["name"]])
            assert dept is not None
            dept.head_role_id = roles[d["head"]]
        await s.flush()
        await s.execute(select(func.rebuild_role_closure(tenant_id)))
        metrics = await _seed_wiring(s, slug, tenant_id, spec, roles)
        if history := spec.get("history"):
            entries = yaml.safe_load((TENANTS_FILE.parent / history).read_text(encoding="utf-8"))
            await s.flush()
            await _seed_history(s, tenant_id, spec, entries, roles, people, metrics)

    async with global_tx("owner") as s:
        for p in spec["people"]:
            s.add(
                LoginIdentity(
                    email=p["email"],
                    tenant_id=tenant_id,
                    person_id=people[p["email"]],
                    password_hash=_seed_hash(),
                )
            )
    log.info("seed.tenant", tenant=spec["name"], roles=len(roles), people=len(people))


async def _seed_wiring(
    s: AsyncSession,
    slug: str,
    tenant_id: uuid.UUID,
    spec: dict[str, Any],
    roles: dict[str, uuid.UUID],
) -> dict[str, uuid.UUID]:
    """Warehouse connection, archetype mappings, metrics and role metrics (onboarding 1 and 5)."""
    if wh := spec.get("warehouse"):
        s.add(WarehouseConnection(tenant_id=tenant_id, status="ok", **wh))
    for archetype, m in spec.get("mappings", {}).items():
        s.add(
            ArchetypeMapping(
                tenant_id=tenant_id,
                archetype_key=archetype,
                source=m["source"],
                columns=m["columns"],
            )
        )
    metrics = {}
    for m in spec.get("metrics", []):
        metrics[m["key"]] = sid(slug, "metric", m["key"])
        s.add(
            Metric(
                id=metrics[m["key"]],
                tenant_id=tenant_id,
                key=m["key"],
                name=m["name"],
                sql_template_key=m["template"],
                sql_template_version=m["version"],
                params=m.get("params", {}),
                unit=m["unit"],
                higher_is_better=m["higher_is_better"],
                unit_value=Decimal(str(m["unit_value"])),
            )
        )
    await s.flush()
    for rm in spec.get("role_metrics", []):
        threshold = rm.get("threshold")
        s.add(
            RoleMetric(
                tenant_id=tenant_id,
                role_node_id=roles[rm["role"]],
                metric_id=metrics[rm["metric"]],
                weight=Decimal(str(rm["weight"])),
                threshold=Decimal(str(threshold)) if threshold is not None else None,
                daily_check=rm.get("daily_check", False),
            )
        )
    return metrics


async def _seed_history(
    s: AsyncSession,
    tenant_id: uuid.UUID,
    spec: dict[str, Any],
    entries: list[dict[str, Any]],
    roles: dict[str, uuid.UUID],
    people: dict[str, uuid.UUID],
    metrics: dict[str, uuid.UUID],
) -> None:
    """Past cards with their fate: feedback, or an initiative the warehouse history can measure."""
    names = {m["key"]: m for m in spec["metrics"]}
    now = datetime.now(UTC)
    for i, h in enumerate(entries):
        created = now - timedelta(weeks=h["weeks_ago"])
        metric = names[h["metric"]]
        current, baseline = float(h["current"]), float(h["baseline"])
        threshold = h.get("threshold")
        gap = current - threshold if threshold is not None else current - baseline
        evidence = {
            "metric": metric["name"],
            "metric_key": metric["key"],
            "signal_kind": h["kind"],
            "unit": metric["unit"],
            "entity": h["entity"],
            "current_week": (created - timedelta(days=created.weekday() + 7)).date().isoformat(),
            "current_value": current,
            "recent_mean": current,
            "recent_weeks": 3,
            "baseline_mean": baseline,
            "baseline_weeks": 13,
            "change_vs_baseline": round(current - baseline, 2),
            "change_vs_baseline_pct": round((current - baseline) / baseline * 100, 1)
            if baseline
            else None,
            "excess_over_threshold": round(gap, 2) if threshold is not None else None,
            "zscore": h.get("zscore"),
            "threshold": threshold,
            "estimated_impact": h["impact"],
            "impact_unit": spec["currency"],
            "exposure": h.get("exposure", 1),
            "series": [],
            "drivers": {},
        }
        fingerprint = f"{metric['key']}:{h['entity']}:{'up' if gap > 0 else 'down'}"
        card = InsightCard(
            id=sid(spec["slug"], "history", str(i)),
            tenant_id=tenant_id,
            role_node_id=roles[h["role"]],
            status=h["status"],
            title=h["title"],
            what=h["what"],
            so_what=h["so_what"],
            now_what=h["now_what"],
            decision_used=h["decision_used"],
            evidence=evidence,
            expected_impact=Decimal(str(h["impact"])),
            impact_unit=spec["currency"],
            confidence=Decimal(str(h["confidence"])),
            priority=1,
            fingerprint=fingerprint,
            language="en",
            suggested_window_days=(h.get("initiative") or {}).get("window_days", 60),
            suggested_metric_key=metric["key"],
            generated_by="seed/history",
            created_at=created,
            expires_at=created + timedelta(days=28),
            closed_at=None if h["status"] == "open" else created + timedelta(days=2),
        )
        s.add(card)
        await s.flush()
        if fb := h.get("feedback"):
            s.add(
                Feedback(
                    tenant_id=tenant_id,
                    card_id=card.id,
                    role_node_id=card.role_node_id,
                    person_id=people[fb["by"]],
                    type=h["status"],
                    reason=fb.get("reason"),
                    created_at=created + timedelta(days=2),
                )
            )
        if ini := h.get("initiative"):
            s.add(
                Initiative(
                    tenant_id=tenant_id,
                    card_id=card.id,
                    role_node_id=card.role_node_id,
                    owner_person_id=people[ini["owner"]],
                    metric_id=metrics[metric["key"]],
                    started_on=created.date(),
                    exposure=Decimal(str(h.get("exposure", 1))),
                    baseline_value=Decimal(str(ini["baseline_value"])),
                    baseline_period=f"3 weeks to {evidence['current_week']}",
                    window_days=ini["window_days"],
                    status="in_progress",
                    created_at=created,
                )
            )


async def seed(reset: bool) -> None:
    settings = get_settings()
    async with global_tx("owner") as s:
        await load_catalog(s, Path(settings.catalog_dir))
        archetypes = {a.key: a.definition for a in (await s.scalars(select(RoleArchetype)))}

    staff = yaml.safe_load(STAFF_FILE.read_text(encoding="utf-8"))
    async with global_tx("owner") as s:
        for u in staff:
            await s.execute(
                pg_insert(StaffUser)
                .values(
                    id=sid("staff", u["email"]),
                    email=u["email"],
                    name=u["name"],
                    staff_role=u["staff_role"],
                    password_hash=_seed_hash(),
                )
                .on_conflict_do_nothing(index_elements=["email"])
            )
        # Staff seeded before passwords existed get the seed password once; later changes stay.
        if hashed := _seed_hash():
            for u in await s.scalars(select(StaffUser).where(StaffUser.password_hash.is_(None))):
                u.password_hash = hashed
    specs = yaml.safe_load(TENANTS_FILE.read_text(encoding="utf-8"))
    for spec in specs:
        tenant_id = sid(spec["slug"])
        async with tenant_tx("owner", tenant_id) as s:
            exists = await s.get(Tenant, tenant_id) is not None
            if exists and reset:
                await s.execute(delete(Tenant).where(Tenant.id == tenant_id))
        if exists and not reset:
            log.info("seed.skip", tenant=spec["name"], reason="exists")
            continue
        await _seed_tenant(spec, archetypes)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--reset", action="store_true", help="drop and recreate demo tenants")
    args = parser.parse_args()
    configure_logging()
    asyncio.run(seed(args.reset))


if __name__ == "__main__":
    main()
