"""Card feedback, Action this, the rule review queue and WF5's rule compiler.

User actions run as app_user (RLS: visible roles; feedback and initiatives only as oneself).
Feedback never changes workflow logic, only data the agent reads, and every rule passes a review.
"""

import uuid
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from app.core.auth import Principal
from app.core.db import tenant_tx
from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.logging import get_logger
from app.domain import feedback as fb_rules
from app.domain import org as org_rules
from app.domain import outcomes as out_rules
from app.models import (
    AuditLog,
    Feedback,
    FeedbackRule,
    Initiative,
    InsightCard,
    Metric,
    RoleAssignment,
    RoleNode,
)
from app.repositories import org as org_repo
from app.services import agents as agent_service
from app.services import scheduler

log = get_logger(__name__)


async def _owner_roles(s: Any, person_id: uuid.UUID) -> set[uuid.UUID]:
    rows = await s.scalars(
        select(RoleAssignment.role_node_id).where(
            RoleAssignment.person_id == person_id,
            RoleAssignment.permission == "owner",
            RoleAssignment.grant_effect == "allow",
        )
    )
    return set(rows)


async def _actionable_card(s: Any, principal: Principal, card_id: uuid.UUID) -> InsightCard:
    card: InsightCard | None = await s.get(InsightCard, card_id)  # RLS: invisible = missing
    if card is None:
        raise NotFound("card")
    nodes = await org_repo.nodes(s)
    if not org_rules.can_act(nodes, card.role_node_id, await _owner_roles(s, principal.person_id)):
        raise Forbidden("only the owner of this role can act on its cards")
    if card.status != "open":
        raise Conflict(f"card is already {card.status}")
    return card


def _audit(
    principal: Principal, action: str, object_type: str, object_id: Any, **detail: Any
) -> AuditLog:
    return AuditLog(
        tenant_id=principal.tenant_id,
        actor=principal.email,
        action=action,
        object_type=object_type,
        object_id=str(object_id),
        detail=detail,
    )


async def _metric_id(s: Any, card: InsightCard) -> uuid.UUID | None:
    key = card.evidence.get("metric_key")
    return await s.scalar(select(Metric.id).where(Metric.key == key)) if key else None


# ---------------------------------------------------------------------------------------------
# Feedback buttons
# ---------------------------------------------------------------------------------------------


async def give_feedback(
    principal: Principal,
    card_id: uuid.UUID,
    type_: str,
    reason: str | None,
    reason_code: str | None = None,
) -> dict[str, Any]:
    if error := fb_rules.check_feedback(type_, reason, reason_code):
        raise Invalid(error)
    stored = fb_rules.encode_reason(reason_code, reason)
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        card = await _actionable_card(s, principal, card_id)
        rules = await org_repo.rules(s)
        fb = Feedback(
            tenant_id=principal.tenant_id,
            card_id=card.id,
            role_node_id=card.role_node_id,
            person_id=principal.person_id,
            type=type_,
            reason=stored,
        )
        s.add(fb)
        # Immediate effect, before any review: the card closes and its fingerprint is
        # suppressed for this role (filtering reads feedback directly).
        card.status, card.closed_at = type_, datetime.now(UTC)
        await s.flush()
        s.add(
            _audit(
                principal, f"card.{type_}", "insight_card", card.id,
                reason=reason, reason_code=reason_code,
            )
        )  # fmt: skip
        feedback_id = fb.id
        suppress_days = rules.not_relevant_suppress_days
        downweight_after = rules.not_relevant_for_downweight
        effect = fb_rules.feedback_effect(type_, reason_code, suppress_days, downweight_after)
    scheduler.on_feedback(principal.tenant_id, feedback_id)  # compile it now, best effort
    return {
        "status": type_,
        "card_id": str(card_id),
        "feedback_id": str(feedback_id),
        "effect": effect,
        "suppress_days": suppress_days,
        "downweight_after": downweight_after,
    }


# ---------------------------------------------------------------------------------------------
# Action this -> initiative
# ---------------------------------------------------------------------------------------------


async def action_defaults(principal: Principal, card_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        card = await _actionable_card(s, principal, card_id)
        rules = await org_repo.rules(s)
    d = out_rules.action_defaults(card.evidence, card.suggested_window_days, rules)
    return {
        "card_id": str(card.id),
        "metric": card.evidence.get("metric"),
        "unit": card.evidence.get("unit"),
        "entity": card.evidence.get("entity"),
        "baseline_value": d.baseline_value,
        "baseline_period": d.baseline_period,
        "window_days": d.window_days,
        "min_window_days": rules.min_window_days,
        "max_window_days": rules.max_window_days,
    }


async def action_card(
    principal: Principal,
    card_id: uuid.UUID,
    baseline_value: float | None,
    baseline_period: str | None,
    window_days: int | None,
    target_value: float | None,
    due_date: date | None,
) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        card = await _actionable_card(s, principal, card_id)
        rules = await org_repo.rules(s)
        metric_id = await _metric_id(s, card)
        if metric_id is None:
            raise Conflict("the card's metric no longer exists")
        d = out_rules.action_defaults(card.evidence, card.suggested_window_days, rules)
        ini = Initiative(
            tenant_id=principal.tenant_id,
            card_id=card.id,
            role_node_id=card.role_node_id,
            owner_person_id=principal.person_id,
            metric_id=metric_id,
            due_date=due_date,
            started_on=date.today(),
            exposure=Decimal(str(d.exposure)),
            baseline_value=Decimal(
                str(baseline_value if baseline_value is not None else d.baseline_value)
            ),
            baseline_period=(baseline_period or d.baseline_period)[:80],
            window_days=out_rules.clamp_window(window_days or d.window_days, rules),
            target_value=Decimal(str(target_value)) if target_value is not None else None,
            status="in_progress",
        )
        s.add(ini)
        card.status, card.closed_at = "actioned", datetime.now(UTC)
        await s.flush()
        s.add(_audit(principal, "card.actioned", "initiative", ini.id, card_id=str(card.id)))
        return {"status": "actioned", "card_id": str(card.id), "initiative_id": str(ini.id)}


async def decide(principal: Principal, initiative_id: uuid.UUID, choice: str) -> dict[str, Any]:
    """End of window: keep doing this, or stop (spec: Actioning and outcomes, step 5)."""
    if choice not in ("keep", "stop"):
        raise Invalid("choice must be keep or stop")
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        ini = await s.get(Initiative, initiative_id)
        if ini is None:
            raise NotFound("initiative")
        if ini.owner_person_id != principal.person_id:
            raise Forbidden("only the initiative owner decides")
        if ini.status != "done":
            raise Conflict("the window has not ended yet")
        ini.keep_or_stop, ini.keep_or_stop_at = choice, datetime.now(UTC)
        s.add(_audit(principal, f"initiative.{choice}", "initiative", ini.id))
    return {"status": "ok", "keep_or_stop": choice}


# ---------------------------------------------------------------------------------------------
# WF5: compile feedback into proposed rules
# ---------------------------------------------------------------------------------------------


async def compile_rules(tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
        metrics = {m.key: m for m in await s.scalars(select(Metric))}
        rows = (
            await s.execute(
                select(Feedback, InsightCard).join(InsightCard, InsightCard.id == Feedback.card_id)
            )
        ).all()
        items = []
        for f, card in rows:
            metric = metrics.get(card.evidence.get("metric_key", ""))
            items.append(
                fb_rules.FeedbackItem(
                    id=f.id,
                    role_node_id=f.role_node_id,
                    type=f.type,
                    reason=f.reason,
                    metric_id=metric.id if metric else None,
                    metric_name=metric.name if metric else card.evidence.get("metric", ""),
                    fingerprint=card.fingerprint,
                )
            )
        existing = [
            fb_rules.ExistingRule(
                r.role_node_id, r.rule_type, r.metric_id, r.fingerprint, r.status,
                frozenset(r.source_feedback_ids or []),
            )
            for r in await s.scalars(select(FeedbackRule))
        ]  # fmt: skip
        proposals = fb_rules.propose_rules(items, existing, rules)
        new_rules = []
        for p in proposals:
            new_rules.append(
                FeedbackRule(
                    tenant_id=tenant_id,
                    role_node_id=p.role_node_id,
                    rule_type=p.rule_type,
                    metric_id=p.metric_id,
                    fingerprint=p.fingerprint,
                    text=p.text,
                    source_feedback_ids=p.source_feedback_ids,
                    status="proposed",
                )
            )
        s.add_all(new_rules)
        await s.flush()
        new_ids = [r.id for r in new_rules]
    # The rule drafter suggests clearer wording for the reviewer (ADR 0022); best effort.
    drafted = 0
    try:
        drafted = await agent_service.draft_rule_texts(tenant_id, new_ids)
    except Exception as exc:  # a drafting failure must not lose the proposals
        log.warning("feedback.draft_failed", error=str(exc)[:300])
    log.info("feedback.compiled", proposed=len(proposals), feedback=len(items))
    return {
        "status": "ok" if proposals else "skipped",
        "proposed": len(proposals),
        "drafted": drafted,
        "feedback": len(items),
    }


# ---------------------------------------------------------------------------------------------
# Review queue (admin)
# ---------------------------------------------------------------------------------------------


async def _rules_payload(s: Any) -> list[dict[str, Any]]:
    titles = dict((await s.execute(select(RoleNode.id, RoleNode.title))).all())
    metric_names = dict((await s.execute(select(Metric.id, Metric.name))).all())
    rules = (await s.scalars(select(FeedbackRule).order_by(FeedbackRule.created_at.desc()))).all()
    source_ids = {fid for r in rules for fid in (r.source_feedback_ids or [])}
    sources = (
        await s.execute(
            select(Feedback, InsightCard.title)
            .join(InsightCard, InsightCard.id == Feedback.card_id)
            .where(Feedback.id.in_(source_ids))
        )
    ).all()
    by_id = {f.id: (f, title) for f, title in sources}
    return [
        {
            "id": str(r.id),
            "role_node_id": str(r.role_node_id),
            "role": titles.get(r.role_node_id, ""),
            "rule_type": r.rule_type,
            "metric": metric_names.get(r.metric_id) if r.metric_id else None,
            "text": r.text,
            "suggested_text": r.suggested_text,
            "status": r.status,
            "created_at": r.created_at.isoformat(),
            "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
            "sources": [
                {"card": by_id[fid][1], "type": by_id[fid][0].type, "reason": by_id[fid][0].reason}
                for fid in (r.source_feedback_ids or [])
                if fid in by_id
            ],
        }
        for r in rules
    ]


async def rules_view(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        return {"rules": await _rules_payload(s)}


async def rules_for_workspace(tenant_id: uuid.UUID) -> list[dict[str, Any]]:
    """Console (service connection): the same view for one workspace."""
    async with tenant_tx("service", tenant_id) as s:
        return await _rules_payload(s)


RATING_MESSAGE = {
    "useful": "Noted as useful.",
    "not_relevant": "Noted as not relevant.",
    "impossible": "Noted as something the role cannot act on.",
    "wrong_number": "Noted. A wrong number is usually a mapping problem: check the mapping.",
}


async def rate_trial_card(
    actor: str, tenant_id: uuid.UUID, card_id: uuid.UUID, rating: str, note: str | None
) -> dict[str, Any]:
    """Our team rates a card of the trial run. Not relevant and Cannot act propose a rule for Rule
    review (nothing changes the card writer until it is accepted); every rating is written to the
    audit log."""
    if error := fb_rules.check_trial_rating(rating, note):
        raise Invalid(error)
    async with tenant_tx("service", tenant_id) as s:
        card = await s.get(InsightCard, card_id)
        if card is None:
            raise NotFound("card")
        role = await s.get(RoleNode, card.role_node_id)
        metric_id = await _metric_id(s, card)
        existing = [
            fb_rules.ExistingRule(
                r.role_node_id, r.rule_type, r.metric_id, r.fingerprint, r.status,
                frozenset(r.source_feedback_ids or []),
            )
            for r in await s.scalars(select(FeedbackRule))
        ]  # fmt: skip
        proposal = fb_rules.trial_rating_rule(
            rating,
            note,
            role_node_id=card.role_node_id,
            role_title=role.title if role else "this role",
            metric_id=metric_id,
            metric_name=str(card.evidence.get("metric", "")),
            fingerprint=card.fingerprint,
            existing=existing,
        )
        rule_id: uuid.UUID | None = None
        if proposal is not None:
            rule = FeedbackRule(
                tenant_id=tenant_id, role_node_id=proposal.role_node_id,
                rule_type=proposal.rule_type, metric_id=proposal.metric_id,
                fingerprint=proposal.fingerprint, text=proposal.text[:500],
                source_feedback_ids=[], status="proposed",
            )  # fmt: skip
            s.add(rule)
            await s.flush()
            rule_id = rule.id
        s.add(
            AuditLog(
                tenant_id=tenant_id, actor=actor, action=f"trial.rate.{rating}",
                object_type="insight_card", object_id=str(card.id),
                detail={"note": (note or "").strip()[:500],
                        "rule_id": str(rule_id) if rule_id else None},
            )
        )  # fmt: skip
    message = RATING_MESSAGE[rating]
    if rule_id:
        message += " A rule is proposed: accept it in Rule review."
    return {"status": "ok", "rating": rating, "rule_id": str(rule_id) if rule_id else None,
            "message": message}  # fmt: skip


REVIEW = {"accept": ("proposed", "active"), "reject": ("proposed", "rejected"),
          "retire": ("active", "retired")}  # fmt: skip


async def _apply_review(
    s: Any, rule_id: uuid.UUID, action: str, text: str | None, reviewer: uuid.UUID | None
) -> FeedbackRule:
    if action not in REVIEW:
        raise Invalid("action must be accept, reject or retire")
    before, after = REVIEW[action]
    rule: FeedbackRule | None = await s.get(FeedbackRule, rule_id)
    if rule is None:
        raise NotFound("rule")
    if rule.status != before:
        raise Conflict(f"rule is {rule.status}, cannot {action}")
    if text is not None and action == "accept":
        if not text.strip():
            raise Invalid("rule text cannot be empty")
        rule.text = text.strip()[:500]
    rule.status, rule.reviewed_by, rule.reviewed_at = after, reviewer, datetime.now(UTC)
    return rule


async def review_rule(
    principal: Principal, rule_id: uuid.UUID, action: str, text: str | None
) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        rule = await _apply_review(s, rule_id, action, text, principal.person_id)
        s.add(_audit(principal, f"rule.{action}", "feedback_rule", rule.id, text=rule.text))
        status = rule.status
    return {"status": status, "rule_id": str(rule_id)}


async def review_rule_as_staff(
    actor: str, tenant_id: uuid.UUID, rule_id: uuid.UUID, action: str, text: str | None
) -> dict[str, Any]:
    """Console: SSA staff work the queue during pilots (spec: Feedback loop)."""
    async with tenant_tx("service", tenant_id) as s:
        rule = await _apply_review(s, rule_id, action, text, None)
        s.add(
            AuditLog(
                tenant_id=tenant_id, actor=actor, action=f"rule.{action}",
                object_type="feedback_rule", object_id=str(rule.id), detail={"text": rule.text},
            )
        )  # fmt: skip
        status = rule.status
    return {"status": status, "rule_id": str(rule_id)}
