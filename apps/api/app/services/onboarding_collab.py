"""Onboarding with the client (ADR 0027): shared progress, questions on steps, the client's org
draft and its imports, notifications, and go-live.

The client side runs as app_user (tenant RLS) and only Owners and Admins see onboarding. It
never sees agent inputs, SQL or checks: `client_view` builds a plain projection. The team side
runs on the service connection from the console.
"""

import base64
import hashlib
import hmac
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select, update

from app.core.auth import Principal
from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.logging import get_logger
from app.core.settings import get_settings
from app.domain import onboarding_flow as flow
from app.domain import org_import as oi
from app.integrations import email
from app.integrations.directory import DirectoryError, get_directory
from app.integrations.org_vision import get_org_vision
from app.models import (
    InsightCard,
    Notification,
    OnboardingMessage,
    OnboardingSignoff,
    OnboardingStep,
    OnboardingThread,
    OrgDraft,
    Person,
    RoleNode,
    Run,
    Tenant,
    WarehouseConnection,
)
from app.services import access, console, onboarding_review

log = get_logger(__name__)
ADMIN_ROLES = ("owner", "admin")
# The trial is the latest full run (weekly or started by hand); daily checks are not trials.
TRIAL_RUN = (
    select(Run).where(Run.type.in_(("weekly", "manual"))).order_by(Run.created_at.desc()).limit(1)
)
BODY_MAX = 4000
MEDIA = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp",
         "heic": "image/heic"}  # fmt: skip


# ---------------------------------------------------------------------------------------------
# Progress (both sides)
# ---------------------------------------------------------------------------------------------


async def _signoffs(s: Any) -> dict[str, OnboardingSignoff]:
    return {r.step: r for r in await s.scalars(select(OnboardingSignoff))}


async def _progress(s: Any, tenant: Tenant) -> flow.Progress:
    wc = await s.scalar(select(WarehouseConnection))
    # Only step and status: the client role may read no other onboarding_step column.
    steps = (
        await s.execute(
            select(OnboardingStep.step, OnboardingStep.status).order_by(
                OnboardingStep.created_at.desc()
            )
        )
    ).all()
    latest: dict[str, str] = {}
    for r in steps:
        latest.setdefault(r.step, r.status)
    signs = {
        k: flow.Signoff(team=r.team_at is not None, client=r.client_at is not None)
        for k, r in (await _signoffs(s)).items()
    }
    threads = (
        await s.execute(
            select(OnboardingThread.step, OnboardingThread.waiting_on).where(
                OnboardingThread.status == "open"
            )
        )
    ).all()
    draft = await s.scalar(select(OrgDraft))
    trial = await s.scalar(select(Run.id).where(Run.status.in_(("succeeded", "partial"))).limit(1))
    return flow.Progress(
        signoffs=signs,
        latest=latest,
        open_threads=[{"step": t.step, "waiting_on": t.waiting_on} for t in threads],
        draft_status=draft.status if draft else None,
        trial_ok=trial is not None,
        connected=bool(wc and wc.status == "ok"),
        live=tenant.lifecycle == "live",
        lab=get_settings().lab_mode,
    )


async def progress(tenant_id: uuid.UUID) -> flow.Progress:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFound("workspace")
        return await _progress(s, tenant)


async def require_team_can_work(tenant_id: uuid.UUID, step: str) -> None:
    """Sequential onboarding: the team works only on the open step (ADR 0027)."""
    if error := flow.team_work_error(await progress(tenant_id), step):
        raise Conflict(error)


async def require_team_can_approve(tenant_id: uuid.UUID, step: str) -> None:
    if error := flow.team_approve_error(await progress(tenant_id), step):
        raise Conflict(error)


def _signoff_view(r: OnboardingSignoff | None) -> dict[str, Any] | None:
    if r is None:
        return None
    return {
        "summary": r.summary,
        "team_by": r.team_by,
        "team_at": r.team_at.isoformat() if r.team_at else None,
        "client_by": r.client_by,
        "client_at": r.client_at.isoformat() if r.client_at else None,
        "reopened": r.reopened,
        "reopened_at": r.reopened_at.isoformat() if r.reopened_at else None,
        "reopen_note": r.reopen_note,
    }


async def _threads(s: Any) -> list[dict[str, Any]]:
    threads = (
        await s.scalars(select(OnboardingThread).order_by(OnboardingThread.updated_at.desc()))
    ).all()
    messages = (
        await s.scalars(select(OnboardingMessage).order_by(OnboardingMessage.created_at))
    ).all()
    by_thread: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for m in messages:
        by_thread.setdefault(m.thread_id, []).append(
            {"id": str(m.id), "side": m.side, "author": m.author, "body": m.body,
             "at": m.created_at.isoformat()}
        )  # fmt: skip
    return [
        {
            "id": str(t.id),
            "step": t.step,
            "title": t.title,
            "raised_by": t.raised_by,
            "waiting_on": t.waiting_on,
            "status": t.status,
            "updated_at": t.updated_at.isoformat(),
            "messages": by_thread.get(t.id, []),
        }
        for t in threads
    ]


def _draft_view(d: OrgDraft | None) -> dict[str, Any]:
    if d is None:
        return {"nodes": [], "status": "draft", "source": "blank", "updated_at": None,
                "updated_by": "", "check": oi.check([]).as_dict()}  # fmt: skip
    return {
        "nodes": d.nodes,
        "status": d.status,
        "source": d.source,
        "updated_at": d.updated_at.isoformat(),
        "updated_by": d.updated_by,
        "submitted_at": d.submitted_at.isoformat() if d.submitted_at else None,
        "check": oi.check(d.nodes).as_dict(),
    }


async def team_extras(tenant_id: uuid.UUID) -> dict[str, Any]:
    """Added to the console's onboarding state."""
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFound("workspace")
        p = await _progress(s, tenant)
        signs = await _signoffs(s)
        threads = await _threads(s)
        draft = await s.scalar(select(OrgDraft))
        run = await s.scalar(TRIAL_RUN)
        cards = (
            await s.scalar(select(func.count()).where(InsightCard.run_id == run.id))
            if run else 0
        )  # fmt: skip
    return {
        "lifecycle": tenant.lifecycle,
        "checkin": _checkin_view(tenant),
        "live_at": tenant.live_at.isoformat() if tenant.live_at else None,
        "progress": {
            "steps": flow.team_steps(p),
            "current": flow.current_step(p),
            "percent": flow.percent(p),
            "blockers": flow.go_live_blockers(p),
            "can_approve": {k: flow.team_approve_error(p, k) for k in flow.TEAM_STEPS},
        },
        "signoffs": {k: _signoff_view(signs.get(k)) for k in flow.TEAM_STEPS},
        "threads": threads,
        "draft": _draft_view(draft),
        "trial": {
            "run_id": str(run.id), "status": run.status, "type": run.type,
            "at": run.created_at.isoformat(), "cards": int(cards or 0),
        } if run else None,
    }  # fmt: skip


async def board() -> list[dict[str, Any]]:
    """The console's Onboarding tab: every workspace still onboarding, where it stands."""
    async with global_tx("service") as s:
        tenants = (
            await s.scalars(
                select(Tenant).where(Tenant.lifecycle == "onboarding").order_by(Tenant.created_at)
            )
        ).all()
    rows = []
    for t in tenants:
        async with tenant_tx("service", t.id) as s:
            p = await _progress(s, t)
            owner = await s.scalar(select(Person).where(Person.app_role == "owner"))
            last = await s.scalar(
                select(func.max(OnboardingThread.updated_at))
            )  # most recent conversation
        cur = flow.current_step(p)
        info = flow.team_step(p, cur)
        rows.append({
            "id": str(t.id), "name": t.name, "created_at": t.created_at.isoformat(),
            "owner": owner.name if owner else None,
            "percent": flow.percent(p), "current": cur, "status": info["status"],
            "steps": [{"key": x["key"], "status": x["status"]} for x in flow.team_steps(p)],
            "questions_for_team": sum(1 for q in p.open_threads if q["waiting_on"] == "team"),
            "questions_for_client": sum(1 for q in p.open_threads if q["waiting_on"] == "client"),
            "waiting_on": "client" if info["status"] in ("client_review", "waiting") else "team",
            "last_activity": last.isoformat() if last else None,
        })  # fmt: skip
    return rows


# ---------------------------------------------------------------------------------------------
# Sign-off (both sides) and reopening (team only)
# ---------------------------------------------------------------------------------------------


async def sign_team(actor: str, tenant_id: uuid.UUID, step: str, summary: dict[str, Any]) -> None:
    """The team approved the step: store the client-safe summary and ask the client to review."""
    async with tenant_tx("service", tenant_id) as s:
        row = (await _signoffs(s)).get(step)
        if row is None:
            row = OnboardingSignoff(tenant_id=tenant_id, step=step, summary={}, reopened=0,
                                    reopen_note="")  # fmt: skip
            s.add(row)
        row.summary, row.team_by, row.team_at = summary, actor, datetime.now(UTC)
        row.client_by, row.client_at = None, None
    await console._log(
        actor, "workspace", f"onboarding.{step}.team_approved", None, None, tenant_id
    )
    await _notify_client(
        tenant_id, "review", f"Ready for your review: {flow_label(step)}",
        "Our team finished this step. Please review it and approve, or ask us a question.",
        _link(step),
    )  # fmt: skip


async def approve_connect(actor: str, tenant_id: uuid.UUID) -> dict[str, Any]:
    await require_team_can_approve(tenant_id, "connect")
    async with tenant_tx("service", tenant_id) as s:
        wc = await s.scalar(select(WarehouseConnection))
    assert wc is not None
    summary = flow.summary_connect(
        wc.database_name, list(wc.schemas),
        wc.last_tested_at.isoformat() if wc.last_tested_at else None,
    )  # fmt: skip
    await sign_team(actor, tenant_id, "connect", summary)
    return {"status": "ok"}


async def _trial_summary(tenant_id: uuid.UUID) -> dict[str, Any] | None:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        run = await s.scalar(
            select(Run)
            .where(Run.type.in_(("weekly", "manual")), Run.status.in_(("succeeded", "partial")))
            .order_by(Run.created_at.desc())
            .limit(1)
        )
        if run is None:
            return None
        cards = (
            await s.execute(
                select(InsightCard.title, RoleNode.title, InsightCard.expected_impact)
                .join(RoleNode, RoleNode.id == InsightCard.role_node_id)
                .where(InsightCard.run_id == run.id)
                .order_by(InsightCard.expected_impact.desc())
            )
        ).all()
    return flow.summary_trial(
        run.status, run.created_at.isoformat(),
        [{"title": c, "role": r, "impact": float(i or 0)} for c, r, i in cards],
        tenant.currency if tenant else "CAD",
    )  # fmt: skip


async def approve_trial(actor: str, tenant_id: uuid.UUID, reason: str = "") -> dict[str, Any]:
    await require_team_can_approve(tenant_id, "trial")
    await onboarding_review.guard_approve(actor, tenant_id, "trial", reason)
    summary = await _trial_summary(tenant_id)
    if summary is None:
        raise Conflict("run the trial first")
    await sign_team(actor, tenant_id, "trial", summary)
    return {"status": "ok"}


async def set_summary(tenant_id: uuid.UUID, step: str, summary: dict[str, Any]) -> bool:
    """Replace the client summary of a step the team already approved (no approval changes)."""
    async with tenant_tx("service", tenant_id) as s:
        row = await s.scalar(select(OnboardingSignoff).where(OnboardingSignoff.step == step))
        if row is None or row.team_at is None:
            return False
        row.summary = summary
    return True


async def set_trial_summary(tenant_id: uuid.UUID) -> bool:
    summary = await _trial_summary(tenant_id)
    return summary is not None and await set_summary(tenant_id, "trial", summary)


async def reopen(actor: str, tenant_id: uuid.UUID, step: str, note: str) -> dict[str, Any]:
    """Team only: reopen a step to edit and update it. Clears this step's two approvals;
    later steps keep theirs (no reset)."""
    if step not in flow.TEAM_STEPS:
        raise Invalid(f"unknown step {step}")
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFound("workspace")
        if tenant.lifecycle == "live":
            raise Conflict("the workspace is live; change it from the workspace config")
        row = (await _signoffs(s)).get(step)
        if row is None or row.team_at is None:
            raise Conflict("only an approved step can be reopened")
        row.team_by = row.team_at = row.client_by = row.client_at = None
        row.reopened += 1
        row.reopened_at, row.reopen_note = datetime.now(UTC), note.strip()[:1000]
        if step == "org":
            draft = await s.scalar(select(OrgDraft))
            if draft is not None and draft.status == "approved":
                draft.status = "submitted"  # the team edits it; the client sees it under review
    await console._log(actor, "workspace", f"onboarding.{step}.reopened", None, {"note": note},
                       tenant_id)  # fmt: skip
    await _notify_client(
        tenant_id, "reopened", f"We reopened: {flow_label(step)}",
        note.strip() or "Our team is updating this step. You will review it again.", _link(step),
    )  # fmt: skip
    return {"status": "ok"}


async def client_go_live(principal: Principal) -> dict[str, Any]:
    """The client reviews the trial and goes live (ADR 0030): unlocks the app and invites the
    people named in their org chart."""
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _client_admin(s, principal)
        tenant = await s.get(Tenant, principal.tenant_id)
        assert tenant is not None
        if error := flow.go_live_error(await _progress(s, tenant)):
            raise Conflict(error)
    result = await go_live(f"client:{me.email}", principal.tenant_id, invite=True)
    log.info("onboarding.client_went_live", invited=len(result["invited"]))
    return result


STEP_LABELS = {
    "connect": "Snowflake connection",
    "discovery": "Data discovery",
    "mapping": "Data mapping",
    "org": "Org Web",
    "metrics": "Role metrics",
    "rules": "Business rules",
    "trial": "Trial run",
}


def flow_label(step: str) -> str:
    return STEP_LABELS.get(step, step)


# ---------------------------------------------------------------------------------------------
# Client view
# ---------------------------------------------------------------------------------------------


async def _client_admin(s: Any, principal: Principal) -> Person:
    me: Person | None = await s.get(Person, principal.person_id)
    if me is None or me.app_role not in ADMIN_ROLES:
        raise Forbidden("only workspace owners and admins take part in onboarding")
    return me


async def client_view(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        tenant = await s.get(Tenant, principal.tenant_id)
        assert tenant is not None
        if principal.app_role not in ADMIN_ROLES:
            return {"lifecycle": tenant.lifecycle, "member": True, "workspace": tenant.name}
        await _client_admin(s, principal)
        p = await _progress(s, tenant)
        signs = await _signoffs(s)
        draft = await s.scalar(select(OrgDraft))
        threads = await _threads(s)
    steps = flow.client_steps(p)
    # Team steps the client may see: those under an open client step.
    opened = {t for x in steps if x["can_open"] for t in x["steps"]}
    return {
        "lifecycle": tenant.lifecycle,
        "member": False,
        "workspace": tenant.name,
        "percent": flow.percent(p),
        "steps": steps,
        "current": flow.client_current(p),
        "team_current": flow.current_step(p),
        "signoffs": {k: _signoff_view(signs.get(k)) for k in flow.TEAM_STEPS if k in opened},
        "go_live": {"ready": flow.go_live_error(p) is None, "blockers": flow.go_live_blockers(p)},
        "checkin": _checkin_view(tenant),
        "threads": [t for t in threads if t["step"] in opened or t["step"] == "workspace"],
        "draft": _draft_view(draft) if "org" in opened else None,
        "can_edit_draft": flow.team_work_error(p, "org") is None and tenant.lifecycle != "live",
        "live_at": tenant.live_at.isoformat() if tenant.live_at else None,
    }


# ---------------------------------------------------------------------------------------------
# Questions
# ---------------------------------------------------------------------------------------------


def _clean_body(body: str) -> str:
    body = body.strip()
    if not body:
        raise Invalid("write a message")
    if len(body) > BODY_MAX:
        raise Invalid(f"keep messages under {BODY_MAX} characters")
    return body


async def _notify_client(tenant_id: uuid.UUID, kind: str, title: str, body: str, link: str) -> None:
    """In-app notification and an email to every client Owner and Admin."""
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        people = (
            await s.scalars(
                select(Person).where(
                    Person.app_role.in_(ADMIN_ROLES), Person.deactivated_at.is_(None)
                )
            )
        ).all()
        for p in people:
            s.add(Notification(tenant_id=tenant_id, person_id=p.id, kind=kind, title=title[:300],
                               body=body, link=link))  # fmt: skip
    url = f"{get_settings().app_base_url}{link}"
    for p in people:
        try:
            await email.send(email.Mail(
                to=p.email,
                subject=f"{tenant.name if tenant else 'Formada'}: {title}"[:200],
                text=f"{title}\n\n{body}\n\n{url}\n",
                html=f"<p><strong>{_esc(title)}</strong></p><p>{_esc(body)}</p>"
                     f'<p><a href="{url}">Open onboarding</a></p>',
            ))  # fmt: skip
        except OSError as e:  # mail is best effort; the in-app notification is the record
            log.warning("onboarding.notify_mail_failed", error=str(e))


def _esc(v: str) -> str:
    return v.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "<br>")


# Team step -> the client's step page (the client sees five steps, ADR 0030).
CLIENT_PAGE = {"connect": "connect", "discovery": "prepare", "mapping": "prepare", "org": "org",
               "metrics": "metrics", "rules": "metrics", "trial": "live"}  # fmt: skip


def _link(step: str, thread_id: uuid.UUID | None = None) -> str:
    page = f"/onboarding/{CLIENT_PAGE.get(step, step)}"
    return f"{page}?thread={thread_id}" if thread_id else page


def _checkin_view(tenant: Tenant) -> dict[str, Any] | None:
    if tenant.checkin_at is None:
        return None
    return {"at": tenant.checkin_at.isoformat(), "note": tenant.checkin_note,
            "lead": tenant.checkin_lead, "timezone": tenant.timezone}  # fmt: skip


async def set_checkin(
    actor: str, tenant_id: uuid.UUID, at: datetime | None, note: str, lead: str
) -> dict[str, Any]:
    """Our team schedules (or clears) the next check-in shown to the client."""
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFound("workspace")
        tenant.checkin_at, tenant.checkin_note, tenant.checkin_lead = at, note[:500], lead[:200]
        view = _checkin_view(tenant)
    await console._log(actor, "workspace", "onboarding.checkin", None,
                       {"at": at.isoformat() if at else None}, tenant_id)  # fmt: skip
    return {"status": "ok", "checkin": view}


async def _ask(
    s: Any, tenant_id: uuid.UUID, side: str, author: str, step: str, title: str, body: str
) -> OnboardingThread:
    if step not in flow.TEAM_STEPS:
        raise Invalid(f"unknown step {step}")
    t = OnboardingThread(
        tenant_id=tenant_id, step=step, title=(title.strip() or body)[:300], raised_by=side,
        waiting_on="client" if side == "team" else "team", status="open",
        updated_at=datetime.now(UTC),
    )  # fmt: skip
    s.add(t)
    await s.flush()
    s.add(OnboardingMessage(tenant_id=tenant_id, thread_id=t.id, side=side, author=author,
                            body=body))  # fmt: skip
    return t


async def _reply(
    s: Any, tenant_id: uuid.UUID, thread_id: uuid.UUID, side: str, author: str, body: str
) -> OnboardingThread:
    t: OnboardingThread | None = await s.get(OnboardingThread, thread_id)
    if t is None:
        raise NotFound("question")
    s.add(OnboardingMessage(tenant_id=tenant_id, thread_id=t.id, side=side, author=author,
                            body=body))  # fmt: skip
    t.waiting_on = "client" if side == "team" else "team"
    t.status, t.resolved_at, t.resolved_by = "open", None, None  # a reply reopens
    t.updated_at = datetime.now(UTC)
    return t


async def _resolve(s: Any, thread_id: uuid.UUID, actor: str) -> None:
    t = await s.get(OnboardingThread, thread_id)
    if t is None:
        raise NotFound("question")
    t.status, t.resolved_by, t.resolved_at = "resolved", actor, datetime.now(UTC)
    t.updated_at = datetime.now(UTC)


def _staff_name(actor: str) -> str:
    return "Formada team"  # clients see the team, not the staff member's email


async def team_ask(
    actor: str, tenant_id: uuid.UUID, step: str, title: str, body: str
) -> dict[str, Any]:
    body = _clean_body(body)
    async with tenant_tx("service", tenant_id) as s:
        t = await _ask(s, tenant_id, "team", _staff_name(actor), step, title, body)
        tid = t.id
    await console._log(actor, "workspace", "onboarding.question", None, {"step": step}, tenant_id)
    await _notify_client(tenant_id, "question", title.strip() or "A question from our team", body,
                         _link(step, tid))  # fmt: skip
    return {"status": "ok", "id": str(tid)}


async def team_reply(
    actor: str, tenant_id: uuid.UUID, thread_id: uuid.UUID, body: str
) -> dict[str, Any]:
    body = _clean_body(body)
    async with tenant_tx("service", tenant_id) as s:
        t = await _reply(s, tenant_id, thread_id, "team", _staff_name(actor), body)
        step, title = t.step, t.title
    await _notify_client(tenant_id, "reply", f"Reply: {title}", body, _link(step, thread_id))
    return {"status": "ok"}


async def team_resolve(actor: str, tenant_id: uuid.UUID, thread_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        await _resolve(s, thread_id, actor)
    return {"status": "ok"}


async def client_ask(principal: Principal, step: str, title: str, body: str) -> dict[str, Any]:
    body = _clean_body(body)
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _client_admin(s, principal)
        tenant = await s.get(Tenant, principal.tenant_id)
        assert tenant is not None
        # A live workspace can still write to the team from the Help center (ADR 0030).
        if tenant.lifecycle != "live" and not flow.is_open(await _progress(s, tenant), step):
            raise Conflict("this step is not open yet")
        t = await _ask(s, principal.tenant_id, "client", me.name, step, title, body)
        return {"status": "ok", "id": str(t.id)}


async def client_reply(principal: Principal, thread_id: uuid.UUID, body: str) -> dict[str, Any]:
    body = _clean_body(body)
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _client_admin(s, principal)
        await _reply(s, principal.tenant_id, thread_id, "client", me.name, body)
    return {"status": "ok"}


async def client_resolve(principal: Principal, thread_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _client_admin(s, principal)
        await _resolve(s, thread_id, me.name)
    return {"status": "ok"}


# ---------------------------------------------------------------------------------------------
# Org draft (client builds, team reviews)
# ---------------------------------------------------------------------------------------------


async def _draft(s: Any, tenant_id: uuid.UUID) -> OrgDraft:
    d: OrgDraft | None = await s.scalar(select(OrgDraft))
    if d is None:
        d = OrgDraft(tenant_id=tenant_id, nodes=[], source="blank", status="draft", updated_by="",
                     updated_at=datetime.now(UTC))  # fmt: skip
        s.add(d)
        await s.flush()
    return d


async def _require_org_open(s: Any, principal: Principal) -> None:
    tenant = await s.get(Tenant, principal.tenant_id)
    assert tenant is not None
    p = await _progress(s, tenant)
    if not flow.is_open(p, "org"):
        raise Conflict("your organisation step opens once the earlier steps are approved")
    if p.sign("org").team:
        raise Conflict("our team approved your org web; ask us if something should change")


async def _write_draft(
    principal: Principal, nodes: list[dict[str, Any]], source: str | None = None
) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _client_admin(s, principal)
        await _require_org_open(s, principal)
        d = await _draft(s, principal.tenant_id)
        if d.status != "draft":
            raise Conflict(
                "the chart is with our team for review; withdraw it to edit"
                if d.status == "submitted" else "the org web is approved and can no longer change"
            )  # fmt: skip
        try:
            d.nodes = oi.clean(nodes)
        except ValueError as e:
            raise Invalid(str(e)) from e
        if source:
            d.source = source
        d.updated_by, d.updated_at = me.name, datetime.now(UTC)
        return _draft_view(d)


async def save_draft(principal: Principal, nodes: list[dict[str, Any]]) -> dict[str, Any]:
    return await _write_draft(principal, nodes)


async def submit_draft(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _client_admin(s, principal)
        await _require_org_open(s, principal)
        d = await _draft(s, principal.tenant_id)
        if d.status != "draft":
            raise Conflict(f"the chart is already {d.status}")
        report = oi.check(d.nodes)
        if not report.ok:
            raise Invalid("; ".join(report.errors))
        d.status, d.submitted_at = "submitted", datetime.now(UTC)
        d.updated_by, d.updated_at = me.name, datetime.now(UTC)
        return _draft_view(d)


async def withdraw_draft(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        await _client_admin(s, principal)
        await _require_org_open(s, principal)
        d = await _draft(s, principal.tenant_id)
        if d.status != "submitted":
            raise Conflict("only a chart waiting for review can be withdrawn")
        d.status, d.submitted_at = "draft", None
        return _draft_view(d)


async def return_draft(actor: str, tenant_id: uuid.UUID, message: str) -> dict[str, Any]:
    """The team sends the chart back to the client with a question on the org step."""
    message = _clean_body(message)
    async with tenant_tx("service", tenant_id) as s:
        d = await s.scalar(select(OrgDraft))
        if d is None or d.status != "submitted":
            raise Conflict("there is no submitted chart to send back")
        d.status, d.submitted_at = "draft", None
        await _ask(s, tenant_id, "team", _staff_name(actor), "org",
                   "Changes needed on your org chart", message)  # fmt: skip
    await _notify_client(tenant_id, "org_returned", "Changes needed on your org chart", message,
                         "/onboarding/organisation")  # fmt: skip
    return {"status": "ok"}


async def mark_draft_approved(tenant_id: uuid.UUID) -> None:
    """Called when the team approves the org step built from the draft (the client is then
    asked to review the org web through the sign-off)."""
    async with tenant_tx("service", tenant_id) as s:
        await s.execute(update(OrgDraft).values(status="approved"))


async def approved_draft_nodes(tenant_id: uuid.UUID) -> list[dict[str, Any]] | None:
    async with tenant_tx("service", tenant_id) as s:
        d = await s.scalar(select(OrgDraft))
    return d.nodes if d and d.status in ("submitted", "approved") and d.nodes else None


# ---- imports -------------------------------------------------------------------------------


def _kind(filename: str) -> str:
    return filename.rsplit(".", 1)[-1].lower() if "." in filename else ""


async def import_file(principal: Principal, filename: str, content_b64: str) -> dict[str, Any]:
    try:
        data = base64.b64decode(content_b64, validate=True)
    except ValueError as e:
        raise Invalid("the upload is not readable") from e
    if len(data) > oi.MAX_UPLOAD_BYTES:
        raise Invalid("the file is larger than 5 MB")
    kind = _kind(filename)
    try:
        if kind in oi.IMAGE_KINDS:
            boxes, lines = await get_org_vision().read(data, MEDIA[kind])
            nodes, source = oi.from_graph(boxes, lines), "photo"
        elif kind in oi.FILE_KINDS:
            nodes, source = oi.parse_file(kind, data), "file"
        else:
            raise oi.ImportError_(
                "use a photo (PNG, JPG), Excel or CSV, Visio (.vsdx) or PowerPoint (.pptx)"
            )
    except oi.ImportError_ as e:
        raise Invalid(str(e)) from e
    log.info("onboarding.org_import", kind=kind, roles=len(nodes))
    return await _write_draft(principal, nodes, source)


async def import_template(principal: Principal, key: str) -> dict[str, Any]:
    try:
        nodes = oi.template(key, principal.locale)
    except oi.ImportError_ as e:
        raise Invalid(str(e)) from e
    return await _write_draft(principal, nodes, "template" if key != "blank" else "blank")


def _state(principal: Principal) -> str:
    key = (get_settings().auth_jwt_secret or "local").encode()
    msg = f"{principal.tenant_id}:{principal.person_id}:directory".encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:32]


def microsoft_consent_url(principal: Principal) -> dict[str, Any]:
    if principal.app_role not in ADMIN_ROLES:
        raise Forbidden("only workspace owners and admins take part in onboarding")
    redirect = f"{get_settings().app_base_url}/onboarding/microsoft"
    try:
        url = get_directory().consent_url(redirect, _state(principal))
    except DirectoryError as e:
        raise Conflict(str(e)) from e
    return {"url": url, "mock": get_settings().directory_backend == "mock"}


async def import_microsoft(
    principal: Principal, directory_tenant: str, state: str
) -> dict[str, Any]:
    if not hmac.compare_digest(state, _state(principal)):
        raise Forbidden("this Microsoft sign-in was not started here; try again")
    if not directory_tenant or len(directory_tenant) > 100:
        raise Invalid("Microsoft did not say which directory to read")
    try:
        users = await get_directory().users(directory_tenant)
        nodes = oi.from_directory(users)
    except (DirectoryError, oi.ImportError_) as e:
        raise Invalid(str(e)) from e
    return await _write_draft(principal, nodes, "microsoft")


# ---------------------------------------------------------------------------------------------
# Notifications
# ---------------------------------------------------------------------------------------------


async def notifications(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        rows = (
            await s.scalars(
                select(Notification).order_by(Notification.created_at.desc()).limit(100)
            )
        ).all()
    return {
        "unread": sum(1 for r in rows if r.read_at is None),
        "items": [
            {"id": str(r.id), "kind": r.kind, "title": r.title, "body": r.body, "link": r.link,
             "at": r.created_at.isoformat(), "read": r.read_at is not None}
            for r in rows
        ],
    }  # fmt: skip


async def mark_read(principal: Principal, ids: list[uuid.UUID] | None) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        q = update(Notification).where(Notification.read_at.is_(None))
        if ids:
            q = q.where(Notification.id.in_(ids))
        await s.execute(q.values(read_at=datetime.now(UTC)))
    return {"status": "ok"}


async def unread_count(principal: Principal) -> int:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        n = await s.scalar(
            select(func.count()).select_from(Notification).where(Notification.read_at.is_(None))
        )
    return int(n or 0)


# ---------------------------------------------------------------------------------------------
# Go live
# ---------------------------------------------------------------------------------------------


async def go_live(actor: str, tenant_id: uuid.UUID, invite: bool) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        if tenant is None:
            raise NotFound("workspace")
        blockers = flow.go_live_blockers(await _progress(s, tenant))
        if blockers:
            raise Conflict("not ready to go live: " + "; ".join(blockers))
        owner = await s.scalar(select(Person).where(Person.app_role == "owner"))
        org_step = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == "org", OnboardingStep.status == "approved")
            .order_by(OnboardingStep.created_at.desc())
            .limit(1)
        )
        draft = await s.scalar(select(OrgDraft))
        tenant.lifecycle, tenant.live_at = "live", datetime.now(UTC)
    invited, skipped = [], []
    if invite and owner and draft and org_step and org_step.applied:
        principal = Principal(tenant_id=tenant_id, person_id=owner.id, email=owner.email,
                              name=owner.name, app_role="owner", locale=owner.locale)  # fmt: skip
        for p in oi.people(draft.nodes, org_step.applied.get("roles", {})):
            if p["email"] == owner.email:
                continue
            try:
                hold = [{"role_node_id": p["role_node_id"], "permission": "owner"}]
                await access.invite(principal, p["email"], p["name"], "member", owner.locale, hold)
                invited.append(p["email"])
            except (Conflict, Invalid) as e:
                skipped.append({"email": p["email"], "reason": str(e)})
    await console._log(actor, "workspace", "workspace.live", None,
                       {"invited": len(invited)}, tenant_id)  # fmt: skip
    await _notify_client(
        tenant_id, "live", "Your workspace is live",
        "Your first insight cards are ready on the org web.", "/dashboard",
    )  # fmt: skip
    return {"status": "ok", "invited": invited, "skipped": skipped}


async def client_trial(principal: Principal) -> dict[str, Any]:
    """The latest trial run and its cards, for the client's trial step. Cards are read as the
    client (role visibility applies); nothing technical is returned."""
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        await _client_admin(s, principal)
        tenant = await s.get(Tenant, principal.tenant_id)
        assert tenant is not None
        if not flow.is_open(await _progress(s, tenant), "trial"):
            raise Conflict("the trial step is not open yet")
        run = await s.scalar(TRIAL_RUN)
        if run is None:
            return {"run": None, "cards": []}
        cards = (
            await s.scalars(
                select(InsightCard)
                .where(InsightCard.run_id == run.id)
                .order_by(InsightCard.expected_impact.desc())
            )
        ).all()
        titles = {r.id: r.title for r in await s.scalars(select(RoleNode))}
    return {
        "run": {"status": run.status, "at": run.created_at.isoformat(),
                "ended_at": run.ended_at.isoformat() if run.ended_at else None},
        "cards": [console.card_view(c, titles.get(c.role_node_id, "")) for c in cards],
    }  # fmt: skip
