"""Review by exception for the team (ADR 0029).

For each onboarding step: a short checklist computed by code, the decision line the client will
read, and how long the step has taken. Approving past an open warning needs a reason, which goes
into the audit log.
"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import func, select

from app.core.db import tenant_tx
from app.core.errors import Conflict
from app.core.logging import get_logger
from app.domain import onboarding as ob
from app.domain import onboarding_flow as flow
from app.domain import plain
from app.models import (
    AuditLog,
    InsightCard,
    OnboardingSignoff,
    OnboardingStep,
    OnboardingThread,
    OrgDraft,
    RoleNode,
    Run,
    RunStep,
    Tenant,
    WarehouseConnection,
)
from app.repositories import org as org_repo

log = get_logger(__name__)

# Names that usually mean a location no longer trades (cards should not name them).
CLOSED_HINTS = ("legacy", "closed", "retired", "inactive", "old ")


def _refs(titles: list[str]) -> list[str]:
    import re

    out: list[str] = []
    for t in sorted(titles):
        base = re.sub(r"[^a-z0-9]+", "_", t.lower()).strip("_") or "role"
        ref, n = base, 2
        while ref in out:
            ref, n = f"{base}_{n}", n + 1
        out.append(ref)
    return out


async def _load(tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        assert tenant is not None
        wc = await s.scalar(select(WarehouseConnection))
        rows = (
            await s.scalars(select(OnboardingStep).order_by(OnboardingStep.created_at.desc()))
        ).all()
        latest: dict[str, OnboardingStep] = {}
        for r in rows:
            latest.setdefault(r.step, r)
        signs = {r.step: r for r in await s.scalars(select(OnboardingSignoff))}
        threads = (await s.execute(select(OnboardingThread.step, OnboardingThread.raised_by))).all()
        draft = await s.scalar(select(OrgDraft))
        roles = (await s.scalars(select(RoleNode))).all()
        rules = await org_repo.rules(s)
        run = await s.scalar(
            select(Run).where(Run.type.in_(("weekly", "manual"))).order_by(Run.created_at.desc())
        )
        cards: list[dict[str, Any]] = []
        rejected = 0
        if run is not None:
            cards = [
                {"title": t, "role": r}
                for t, r in (
                    await s.execute(
                        select(InsightCard.title, RoleNode.title)
                        .join(RoleNode, RoleNode.id == InsightCard.role_node_id)
                        .where(InsightCard.run_id == run.id)
                    )
                ).all()
            ]
            rejected = int(
                await s.scalar(
                    select(
                        func.coalesce(func.sum(RunStep.detail["rejected"].as_integer()), 0)
                    ).where(RunStep.run_id == run.id)
                )
                or 0
            )
    return {
        "tenant": tenant, "wc": wc, "latest": latest, "signs": signs, "threads": threads,
        "draft": draft, "roles": roles, "rules": rules, "run": run, "cards": cards,
        "rejected": rejected,
    }  # fmt: skip


def _conn_view(wc: WarehouseConnection | None) -> dict[str, Any] | None:
    if wc is None:
        return None
    return {"status": wc.status, "test_result": wc.test_result, "role_name": wc.role_name,
            "schemas": wc.schemas}  # fmt: skip


def _preview(step: str, row: OnboardingStep | None, d: dict[str, Any]) -> dict[str, Any] | None:
    """The client summary approving would write, computed without side effects."""
    sign = d["signs"].get(step)
    if sign is not None and sign.team_at is not None and sign.summary:
        return dict(sign.summary)
    if row is None or not row.output or row.output.get("raw"):
        return None
    out = row.output
    if step == "discovery":
        return flow.summary_discovery(out, (row.input or {}).get("profile"))
    if step == "mapping":
        by = (row.checks or {}).get("archetypes", {})
        ok = [a["archetype"] for a in out.get("archetypes", [])
              if a["status"] != "unmappable" and by.get(a["archetype"], {}).get("ok")]  # fmt: skip
        return flow.summary_mapping(out, by, ok)
    if step == "org":
        return flow.summary_org(out, None)
    if step == "metrics":
        titles = dict(zip(_refs([r.title for r in d["roles"]]),
                          sorted(r.title for r in d["roles"]), strict=True))  # fmt: skip
        return flow.summary_metrics(out, titles, d["tenant"].currency)
    if step == "rules":
        _report, clean = ob.check_rules(out)
        return flow.summary_rules([], {}, d["rules"].with_overrides(clean), d["tenant"].currency)
    return None


def _checklist(step: str, d: dict[str, Any], summaries: dict[str, Any]) -> list[dict[str, Any]]:
    row = d["latest"].get(step)
    out = (row.output or {}) if row else {}
    if step == "connect":
        return plain.checks_connect(_conn_view(d["wc"]))
    if step == "trial":
        names = [n for ns in (summaries.get("mapping") or {}).get("locations", {}).values()
                 for n in ns.get("names", [])]  # fmt: skip
        closed = [n for n in names if any(h in f"{n.lower()} " for h in CLOSED_HINTS)]
        run = {"status": d["run"].status} if d["run"] else None
        return plain.checks_trial(run, d["cards"], [r.title for r in d["roles"]], closed,
                                  d["rejected"])  # fmt: skip
    if row is None or not out or out.get("raw"):
        return []
    if step == "discovery":
        threads = [{"step": t.step, "raised_by": t.raised_by} for t in d["threads"]]
        return plain.checks_discovery(out, threads)
    if step == "mapping":
        return plain.checks_mapping(out, row.checks or {})
    if step == "org":
        titles = [n.get("title", "") for n in (d["draft"].nodes if d["draft"] else [])]
        return plain.checks_org(out, titles if (row.checks or {}).get("from_client_draft") else [])
    if step == "metrics":
        return plain.checks_metrics(out, _refs([r.title for r in d["roles"]]))
    report, clean = ob.check_rules(out)
    return plain.checks_rules(clean, d["rules"], report.errors)


def _timing(d: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Minutes from the step opening to each side's approval, and questions asked."""
    out: dict[str, dict[str, Any]] = {}
    opened: datetime = d["tenant"].created_at
    asked: dict[str, int] = {}
    for t in d["threads"]:
        asked[t.step] = asked.get(t.step, 0) + 1
    for step in flow.TEAM_STEPS:
        sign = d["signs"].get(step)
        team_at = sign.team_at if sign else None
        client_at = sign.client_at if sign else None
        out[step] = {
            "opened_at": opened.isoformat() if opened else None,
            "team_minutes": round((team_at - opened).total_seconds() / 60) if team_at and opened
            else None,
            "client_minutes": round((client_at - team_at).total_seconds() / 60)
            if client_at and team_at else None,
            "questions": asked.get(step, 0),
        }  # fmt: skip
        opened = max(team_at, client_at) if team_at and client_at else None  # type: ignore[assignment]
    return out


async def review(tenant_id: uuid.UUID) -> dict[str, Any]:
    d = await _load(tenant_id)
    summaries = {k: dict(v.summary or {}) for k, v in d["signs"].items() if v.team_at}
    previews = {k: _preview(k, d["latest"].get(k), d) for k in flow.TEAM_STEPS}
    if d["run"] is not None and "trial" not in summaries:
        people = len({c["role"] for c in d["cards"]})
        previews["trial"] = {"cards": len(d["cards"]), "people": people}
    return {
        "checklists": {
            k: [{**c, "soft": (k, c["key"]) in plain.SOFT} for c in _checklist(k, d, summaries)]
            for k in flow.TEAM_STEPS
        },
        "decisions": {
            k: plain.decision_line(k, previews.get(k) or {})
            for k in flow.TEAM_STEPS
            if k == "connect" or previews.get(k) is not None
        },
        "timing": _timing(d),
    }


async def open_warnings(tenant_id: uuid.UUID, step: str) -> list[str]:
    d = await _load(tenant_id)
    summaries = {k: dict(v.summary or {}) for k, v in d["signs"].items() if v.team_at}
    return [c["title"] for c in plain.blocking(step, _checklist(step, d, summaries))]


async def guard_approve(actor: str, tenant_id: uuid.UUID, step: str, reason: str) -> None:
    """Approving with an open warning needs a reason; the override is audited."""
    warnings = await open_warnings(tenant_id, step)
    if not warnings:
        return
    if not reason.strip():
        raise Conflict(
            f"{len(warnings)} check(s) need attention ({'; '.join(warnings)}). "
            "Give a reason to approve anyway."
        )
    async with tenant_tx("service", tenant_id) as s:
        s.add(
            AuditLog(
                tenant_id=tenant_id, actor=actor, action="onboarding.approve_override",
                object_type="onboarding_step", object_id=step,
                detail={"warnings": warnings, "reason": reason.strip()[:500]},
            )
        )  # fmt: skip
    log.info("onboarding.approve_override", step=step, warnings=len(warnings))
