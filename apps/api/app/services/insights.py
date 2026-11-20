"""Read models for the web app: dashboard, value ledger, card history and usage. Everything runs
as app_user, so RLS limits cards, initiatives and outcomes to the caller's visible roles."""

import uuid
from collections import Counter, defaultdict
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import func, select

from app.core.auth import Principal
from app.core.db import tenant_tx
from app.domain import llm as llm_catalog
from app.domain import runs as run_rules
from app.models import (
    Department,
    Feedback,
    Initiative,
    InsightCard,
    Metric,
    Outcome,
    Person,
    RoleNode,
    Run,
    Tenant,
    WarehouseConnection,
)
from app.repositories import org as org_repo
from app.services.llm_settings import effective_choice
from app.services.ops import XS_CREDITS_PER_SECOND

QUALITY_DAYS = 90


def _f(v: Decimal | float | None) -> float:
    return float(v or 0)


async def _roles(s: Any) -> dict[uuid.UUID, dict[str, Any]]:
    visible = await org_repo.visible_role_ids(s)
    rows = await s.execute(
        select(RoleNode.id, RoleNode.title, RoleNode.holder_type, Department.name).outerjoin(
            Department, Department.id == RoleNode.department_id
        )
    )
    return {
        r.id: {"title": r.title, "department": r.name, "vacant": r.holder_type == "vacant"}
        for r in rows
        if r.id in visible
    }


def _card_brief(c: InsightCard, roles: dict[uuid.UUID, dict[str, Any]]) -> dict[str, Any]:
    e = c.evidence or {}
    return {
        "id": str(c.id),
        "role_node_id": str(c.role_node_id),
        "role": roles.get(c.role_node_id, {}).get("title", ""),
        "department": roles.get(c.role_node_id, {}).get("department"),
        "title": c.title,
        "status": c.status,
        "expected_impact": _f(c.expected_impact),
        "impact_unit": c.impact_unit,
        "confidence": _f(c.confidence),
        "signal_kind": e.get("signal_kind"),
        "metric": e.get("metric"),
        "entity": e.get("entity"),
        "created_at": c.created_at.isoformat(),
        "closed_at": c.closed_at.isoformat() if c.closed_at else None,
    }


def _latest_outcomes(outcomes: list[Outcome]) -> dict[uuid.UUID, dict[str, Outcome]]:
    by_ini: dict[uuid.UUID, dict[str, Outcome]] = defaultdict(dict)
    for o in outcomes:
        by_ini[o.initiative_id][o.kind] = o
    return by_ini


def _captured(kinds: dict[str, Outcome]) -> float:
    """Value captured to date: the end measurement, else the midpoint (shown as interim)."""
    o = kinds.get("end") or kinds.get("midpoint")
    return _f(o.value_captured) if o else 0.0


async def dashboard(principal: Principal) -> dict[str, Any]:
    now = datetime.now(UTC)
    since = now - timedelta(days=QUALITY_DAYS)
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        tenant = await s.get(Tenant, principal.tenant_id)
        roles = await _roles(s)
        cards = (await s.scalars(select(InsightCard))).all()
        initiatives = (await s.scalars(select(Initiative))).all()
        outcomes = _latest_outcomes(list((await s.scalars(select(Outcome))).all()))
        runs = (await s.scalars(select(Run).order_by(Run.started_at.desc()).limit(6))).all()
    open_cards = sorted(
        (c for c in cards if c.status == "open"), key=lambda c: c.expected_impact, reverse=True
    )
    recent = [c for c in cards if c.created_at >= since]
    fates = Counter(c.status for c in recent)

    by_dept: dict[str, dict[str, float]] = defaultdict(lambda: {"open_cards": 0, "impact": 0.0})
    by_role: dict[uuid.UUID, Counter[str]] = defaultdict(Counter)
    for c in open_cards:
        d = by_dept[roles.get(c.role_node_id, {}).get("department") or "Executive"]
        d["open_cards"] += 1
        d["impact"] += _f(c.expected_impact)
    for c in recent:
        by_role[c.role_node_id]["shown"] += 1
        by_role[c.role_node_id][c.status] += 1

    weeks: list[dict[str, Any]] = []
    for i in range(7, -1, -1):
        start = (now - timedelta(weeks=i + 1)).date()
        end = (now - timedelta(weeks=i)).date()
        week_cards = [c for c in cards if start < c.created_at.date() <= end]
        weeks.append(
            {
                "week": end.isoformat(),
                "cards": len(week_cards),
                "impact": round(sum(_f(c.expected_impact) for c in week_cards), 2),
            }
        )
    tz = tenant.timezone if tenant else "UTC"
    next_weekly = run_rules.weekly_slot(now, tz)
    if next_weekly <= now:
        next_weekly += timedelta(weeks=1)
    shown = len(recent)
    return {
        "currency": tenant.currency if tenant else "CAD",
        "kpis": {
            "open_cards": len(open_cards),
            "impact_at_stake": round(sum(_f(c.expected_impact) for c in open_cards), 2),
            "value_captured": round(sum(_captured(k) for k in outcomes.values()), 2),
            "initiatives_in_progress": sum(1 for i in initiatives if i.status == "in_progress"),
            "initiatives_done": sum(1 for i in initiatives if i.status == "done"),
            "cards_shown_90d": shown,
            "actioned_rate_90d": round(fates["actioned"] / shown, 3) if shown else None,
            "not_relevant_rate_90d": round(fates["not_relevant"] / shown, 3) if shown else None,
            "roles_visible": len(roles),
        },
        "fates_90d": dict(fates),
        "by_department": [{"name": k, **v} for k, v in sorted(by_dept.items())],
        "by_kind": dict(Counter((c.evidence or {}).get("signal_kind") for c in open_cards)),
        "by_metric": [
            {"metric": m, "cards": n}
            for m, n in Counter((c.evidence or {}).get("metric") for c in open_cards).most_common()
        ],
        "weeks": weeks,
        "top_cards": [_card_brief(c, roles) for c in open_cards[:6]],
        "quality": [
            {"role_node_id": str(rid), "role": roles.get(rid, {}).get("title", ""), **counts}
            for rid, counts in sorted(by_role.items(), key=lambda kv: -kv[1]["shown"])
        ],
        "runs": [
            {
                "id": str(r.id),
                "type": r.type,
                "status": r.status,
                "started_at": r.started_at.isoformat(),
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                "llm_tokens": r.llm_tokens,
            }
            for r in runs
        ],
        "next_weekly_run": next_weekly.isoformat(),
    }


async def ledger(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        tenant = await s.get(Tenant, principal.tenant_id)
        roles = await _roles(s)
        rows = (
            await s.execute(
                select(Initiative, InsightCard, Metric, Person.name)
                .join(InsightCard, InsightCard.id == Initiative.card_id)
                .join(Metric, Metric.id == Initiative.metric_id)
                .join(Person, Person.id == Initiative.owner_person_id)
                .order_by(Initiative.started_on.desc())
            )
        ).all()
        outcomes = _latest_outcomes(list((await s.scalars(select(Outcome))).all()))

    def measurement(o: Outcome | None) -> dict[str, Any] | None:
        if o is None:
            return None
        return {
            "value": _f(o.value),
            "delta": _f(o.delta_vs_baseline),
            "value_captured": _f(o.value_captured),
            "measured_at": o.measured_at.date().isoformat(),
        }

    items = []
    by_dept: dict[str, float] = defaultdict(float)
    by_role: dict[str, float] = defaultdict(float)
    for ini, card, metric, owner in rows:
        kinds = outcomes.get(ini.id, {})
        value = _captured(kinds)
        role = roles.get(ini.role_node_id, {})
        by_dept[role.get("department") or "Executive"] += value
        by_role[role.get("title", "")] += value
        end = ini.started_on + timedelta(days=ini.window_days)
        items.append(
            {
                "id": str(ini.id),
                "card": _card_brief(card, roles),
                "role": role.get("title", ""),
                "department": role.get("department"),
                "metric": metric.name,
                "unit": metric.unit,
                "higher_is_better": metric.higher_is_better,
                "entity": (card.evidence or {}).get("entity"),
                "owner": owner,
                "owner_is_me": ini.owner_person_id == principal.person_id,
                "started_on": ini.started_on.isoformat(),
                "ends_on": end.isoformat(),
                "window_days": ini.window_days,
                "progress": round(
                    min(1.0, max(0.0, (date.today() - ini.started_on).days / ini.window_days)), 3
                ),
                "status": ini.status,
                "keep_or_stop": ini.keep_or_stop,
                "baseline_value": _f(ini.baseline_value),
                "baseline_period": ini.baseline_period,
                "target_value": _f(ini.target_value) if ini.target_value is not None else None,
                "midpoint": measurement(kinds.get("midpoint")),
                "end": measurement(kinds.get("end")),
                "value_captured": value,
            }
        )
    return {
        "currency": tenant.currency if tenant else "CAD",
        "total": round(sum(by_dept.values()), 2),
        "by_department": [{"name": k, "value": round(v, 2)} for k, v in sorted(by_dept.items())],
        "by_role": [{"name": k, "value": round(v, 2)} for k, v in sorted(by_role.items())],
        "initiatives": items,
    }


async def history(
    principal: Principal, role_id: uuid.UUID | None, status: str | None
) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        roles = await _roles(s)
        stmt = select(InsightCard).order_by(InsightCard.created_at.desc()).limit(300)
        if role_id:
            stmt = stmt.where(InsightCard.role_node_id == role_id)
        if status:
            stmt = stmt.where(InsightCard.status == status)
        cards = (await s.scalars(stmt)).all()
        ids = [c.id for c in cards]
        feedback = (
            await s.execute(
                select(Feedback, Person.name)
                .join(Person, Person.id == Feedback.person_id)
                .where(Feedback.card_id.in_(ids))
            )
        ).all()
        initiatives = {
            i.card_id: i
            for i in await s.scalars(select(Initiative).where(Initiative.card_id.in_(ids)))
        }
    fb = {f.card_id: {"type": f.type, "reason": f.reason, "by": name} for f, name in feedback}
    return {
        "cards": [
            {
                **_card_brief(c, roles),
                "feedback": fb.get(c.id),
                "initiative": (
                    {"id": str(i.id), "status": i.status} if (i := initiatives.get(c.id)) else None
                ),
            }
            for c in cards
        ],
        "statuses": dict(Counter(c.status for c in cards)),
    }


async def usage(principal: Principal) -> dict[str, Any]:
    """Admin: warehouse credits and LLM tokens this month against the caps, recent runs and the
    workflow schedule (spec: Cost guardrails)."""
    now = datetime.now(UTC)
    month_start = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        tenant = await s.get(Tenant, principal.tenant_id)
        wc = await s.scalar(select(WarehouseConnection))
        runs = (await s.scalars(select(Run).order_by(Run.started_at.desc()).limit(25))).all()
        month = (
            await s.execute(
                select(
                    func.count(),
                    func.coalesce(func.sum(Run.query_seconds), 0),
                    func.coalesce(func.sum(Run.llm_tokens), 0),
                ).where(Run.started_at >= month_start)
            )
        ).one()
        choice = await effective_choice(s)
    tz = tenant.timezone if tenant else "UTC"
    seconds, tokens = float(month[1]), int(month[2])
    schedule = []
    for kind in run_rules.SCHEDULED_TYPES:
        upcoming = (run_rules.current_slot(kind, now + timedelta(days=d), tz) for d in range(9))
        slot = next(x for x in upcoming if x is not None and x > now)
        schedule.append({"type": kind, "next": slot.isoformat()})
    return {
        "month": {
            "runs": int(month[0]),
            "query_seconds": round(seconds, 3),
            "estimated_credits": round(seconds * XS_CREDITS_PER_SECOND, 4),
            "credit_cap": float(wc.monthly_credit_cap) if wc else None,
            "llm_tokens": tokens,
            "llm_model": f"{choice.provider}/{choice.model}",
            "estimated_llm_cost_usd": llm_catalog.estimated_cost(choice.model, tokens),
        },
        "schedule": schedule,
        "runs": [
            {
                "id": str(r.id),
                "type": r.type,
                "status": r.status,
                "period_end": r.period_end.isoformat(),
                "started_at": r.started_at.isoformat(),
                "ended_at": r.ended_at.isoformat() if r.ended_at else None,
                "query_seconds": _f(r.query_seconds),
                "llm_tokens": r.llm_tokens,
                "error": r.error,
            }
            for r in runs
        ],
    }
