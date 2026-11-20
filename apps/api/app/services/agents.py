"""AI agents (ADR 0022): the registry the internal team manages, the translator, the rule
drafter and the evaluator. Every agent's output is checked by code before anyone sees it."""

import json
import uuid
from collections import defaultdict
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import func, select

from app.core.auth import Principal
from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.logging import get_logger
from app.domain import agents as rules_agents
from app.domain.llm import validate_choice
from app.domain.prompting import Prompt
from app.integrations.llm import get_llm, parse_raw
from app.models import (
    Agent,
    AgentPrompt,
    CardRejection,
    CardTranslation,
    ConfigChange,
    Feedback,
    FeedbackRule,
    InsightCard,
    LlmCallLog,
    Metric,
    OnboardingStep,
    RoleNode,
    Tenant,
)
from app.repositories import agents as agent_repo
from app.repositories import pipeline as repo
from app.schemas.llm import RuleDraftOut, TranslationOut
from app.services.llm_settings import Choice, effective_choice

log = get_logger(__name__)
LANGUAGES = {"en": "English", "fr": "Canadian French"}


async def _choice(s: Any, agent: Agent) -> Choice:
    if agent.model_override:
        provider, _, model = agent.model_override.partition("/")
        if not validate_choice(provider, model):
            return Choice(provider, model, "agent")
    return await effective_choice(s)


# ---------------------------------------------------------------------------------------------
# Translator (spec: card text is translated on demand and cached)
# ---------------------------------------------------------------------------------------------


async def translate_card(principal: Principal, card_id: uuid.UUID, language: str) -> dict[str, Any]:
    if language not in LANGUAGES:
        raise Invalid("language must be en or fr")
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        card = await s.get(InsightCard, card_id)  # RLS: invisible cards read as missing
        if card is None:
            raise NotFound("card")
        if card.language == language:
            return _translation_view(
                card.title, card.what, card.so_what, card.now_what, language, None
            )
        cached = await s.scalar(
            select(CardTranslation).where(
                CardTranslation.card_id == card_id, CardTranslation.language == language
            )
        )
        if cached:
            return _translation_view(
                cached.title,
                cached.what,
                cached.so_what,
                cached.now_what,
                language,
                cached.generated_by,
            )
        found = await agent_repo.active(s, "translator")
        if found is None:
            raise Conflict("the translator agent is not configured")
        agent, prompt = found
        choice = await _choice(s, agent)
        original = {
            "title": card.title,
            "what": card.what,
            "so_what": card.so_what,
            "now_what": card.now_what,
        }
        source_language, role_node_id = card.language, card.role_node_id
    user = f"Translate from {LANGUAGES[source_language]} to {LANGUAGES[language]}.\n" + json.dumps(
        original, ensure_ascii=False, indent=1
    )
    result = await get_llm(choice.provider, choice.model).structured(
        prompt.body, user, TranslationOut, fake=TranslationOut(**original)
    )
    out = result.parsed
    if out is None:
        raise Conflict(f"translation failed: {result.error}")
    # Code checks the model: same digits in every field, or the translation is refused.
    for field, text in original.items():
        if not rules_agents.translation_keeps_numbers(text, getattr(out, field)):
            log.warning("translation.numbers_changed", field=field)
            raise Conflict("the translation changed a number and was refused")
    generated_by = f"{result.provider}/{result.model} · translator v{prompt.version}"
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        s.add(
            CardTranslation(
                tenant_id=principal.tenant_id,
                card_id=card_id,
                role_node_id=role_node_id,
                language=language,
                title=out.title[:120],
                what=out.what,
                so_what=out.so_what,
                now_what=out.now_what,
                generated_by=generated_by,
            )
        )
    return _translation_view(out.title, out.what, out.so_what, out.now_what, language, generated_by)


def _translation_view(
    title: str, what: str, so_what: str, now_what: str, language: str, by: str | None
) -> dict[str, Any]:
    return {
        "title": title,
        "what": what,
        "so_what": so_what,
        "now_what": now_what,
        "language": language,
        "generated_by": by,
    }


# ---------------------------------------------------------------------------------------------
# Rule drafter (called by WF5's compile after proposals are written)
# ---------------------------------------------------------------------------------------------


async def draft_rule_texts(tenant_id: uuid.UUID, rule_ids: list[uuid.UUID]) -> int:
    """Suggest clearer wording for new proposals. Best effort: a failure leaves the rule as is."""
    if not rule_ids:
        return 0
    async with tenant_tx("service", tenant_id) as s:
        found = await agent_repo.active(s, "rule_drafter")
        if found is None:
            return 0
        agent, prompt = found
        choice = await _choice(s, agent)
        rules = (await s.scalars(select(FeedbackRule).where(FeedbackRule.id.in_(rule_ids)))).all()
        titles = dict((await s.execute(select(RoleNode.id, RoleNode.title))).all())
        metrics = dict((await s.execute(select(Metric.id, Metric.name))).all())
        sources = {}
        for r in rules:
            rows = await s.execute(
                select(InsightCard.title, InsightCard.now_what, Feedback.type, Feedback.reason)
                .join(Feedback, Feedback.card_id == InsightCard.id)
                .where(Feedback.id.in_(r.source_feedback_ids or []))
            )
            sources[r.id] = [
                {"card": title, "suggested_action": action, "feedback": kind, "reason": reason}
                for title, action, kind, reason in rows.all()
            ]
        payloads = {
            r.id: {
                "rule_type": r.rule_type,
                "role": titles.get(r.role_node_id, ""),
                "metric": metrics.get(r.metric_id) if r.metric_id else None,
                "current_text": r.text,
                "feedback": sources[r.id],
            }
            for r in rules
        }
    drafted = {}
    for rule_id, payload in payloads.items():
        fake = RuleDraftOut(text=payload["current_text"])
        result = await get_llm(choice.provider, choice.model).structured(
            prompt.body, json.dumps(payload, ensure_ascii=False, indent=1), RuleDraftOut, fake=fake
        )
        if result.parsed and result.parsed.text.strip():
            drafted[rule_id] = result.parsed.text.strip()[:300]
    async with tenant_tx("service", tenant_id) as s:
        for rule_id, text in drafted.items():
            rule = await s.get(FeedbackRule, rule_id)
            if rule is not None:
                rule.suggested_text = text
    return len(drafted)


# ---------------------------------------------------------------------------------------------
# Registry (console)
# ---------------------------------------------------------------------------------------------


async def _tenant_ids() -> list[uuid.UUID]:
    async with global_tx("service") as s:
        return list(await s.scalars(select(Tenant.id)))


async def _usage() -> dict[tuple[str, int], dict[str, Any]]:
    """Per (agent, version), across workspaces: card fates, rejections, calls and tokens."""
    stats: dict[tuple[str, int], dict[str, Any]] = defaultdict(
        lambda: {"statuses": [], "rejected": 0, "calls": 0, "tokens": 0}
    )
    for tenant_id in await _tenant_ids():
        async with tenant_tx("service", tenant_id) as s:
            rows = await s.execute(
                select(InsightCard.agent_key, InsightCard.agent_version, InsightCard.status).where(
                    InsightCard.agent_key.is_not(None)
                )
            )
            for key, version, status in rows.all():
                stats[(str(key), int(version or 0))]["statuses"].append(status)
            calls = await s.execute(
                select(
                    LlmCallLog.agent_key,
                    LlmCallLog.agent_version,
                    func.count(),
                    func.coalesce(func.sum(LlmCallLog.input_tokens + LlmCallLog.output_tokens), 0),
                )
                .where(LlmCallLog.agent_key.is_not(None))
                .group_by(LlmCallLog.agent_key, LlmCallLog.agent_version)
            )
            for key, version, n, tokens in calls.all():
                stats[(str(key), int(version or 0))]["calls"] += int(n)
                stats[(str(key), int(version or 0))]["tokens"] += int(tokens)
            # Onboarding agents record their calls on the onboarding step, not in the card log.
            steps = await s.execute(
                select(
                    OnboardingStep.agent_key,
                    OnboardingStep.agent_version,
                    func.count(),
                    func.coalesce(
                        func.sum(OnboardingStep.input_tokens + OnboardingStep.output_tokens), 0
                    ),
                )
                .where(OnboardingStep.agent_key.is_not(None), OnboardingStep.input_tokens > 0)
                .group_by(OnboardingStep.agent_key, OnboardingStep.agent_version)
            )
            for key, version, n, tokens in steps.all():
                stats[(str(key), int(version or 0))]["calls"] += int(n)
                stats[(str(key), int(version or 0))]["tokens"] += int(tokens)
            rejected = await s.execute(
                select(LlmCallLog.agent_key, LlmCallLog.agent_version, func.count())
                .join(
                    CardRejection,
                    (CardRejection.run_id == LlmCallLog.run_id)
                    & (CardRejection.role_node_id == LlmCallLog.role_node_id),
                )
                .where(LlmCallLog.agent_key.is_not(None))
                .group_by(LlmCallLog.agent_key, LlmCallLog.agent_version)
            )
            for key, version, n in rejected.all():
                stats[(str(key), int(version or 0))]["rejected"] += int(n)
    return stats


def _stats_view(raw: dict[str, Any] | None) -> dict[str, Any]:
    raw = raw or {"statuses": [], "rejected": 0, "calls": 0, "tokens": 0}
    v = rules_agents.version_stats(raw["statuses"], raw["rejected"])
    return {
        "cards": v.cards,
        "actioned": v.actioned,
        "not_relevant": v.not_relevant,
        "impossible": v.impossible,
        "expired": v.expired,
        "open": v.open,
        "rejected": v.rejected,
        "action_rate": v.action_rate,
        "not_relevant_rate": v.not_relevant_rate,
        "rejection_rate": v.rejection_rate,
        "calls": raw["calls"],
        "tokens": raw["tokens"],
    }


async def registry() -> dict[str, Any]:
    async with global_tx("service") as s:
        agents = (await s.scalars(select(Agent).order_by(Agent.kind, Agent.key))).all()
        versions = (await s.scalars(select(AgentPrompt))).all()
    usage = await _usage()
    by_agent: dict[str, list[AgentPrompt]] = defaultdict(list)
    for v in versions:
        by_agent[v.agent_key].append(v)
    return {
        "agents": [
            {
                "key": a.key,
                "name": a.name,
                "kind": a.kind,
                "playbook": a.playbook,
                "description": a.description,
                "active_version": a.active_version,
                "versions": len(by_agent[a.key]),
                "model_override": a.model_override,
                "use_examples": a.use_examples,
                "stats": _stats_view(usage.get((a.key, a.active_version))),
            }
            for a in agents
        ]
    }


async def detail(key: str) -> dict[str, Any]:
    async with global_tx("service") as s:
        agent = await s.get(Agent, key)
        if agent is None:
            raise NotFound("agent")
        versions = (
            await s.scalars(
                select(AgentPrompt)
                .where(AgentPrompt.agent_key == key)
                .order_by(AgentPrompt.version.desc())
            )
        ).all()
    usage = await _usage()
    return {
        "key": agent.key,
        "name": agent.name,
        "kind": agent.kind,
        "playbook": agent.playbook,
        "description": agent.description,
        "active_version": agent.active_version,
        "model_override": agent.model_override,
        "use_examples": agent.use_examples,
        "versions": [
            {
                "version": v.version,
                "body": v.body,
                "notes": v.notes,
                "created_by": v.created_by,
                "created_at": v.created_at.isoformat(),
                "active": v.version == agent.active_version,
                "stats": _stats_view(usage.get((key, v.version))),
            }
            for v in versions
        ],
    }


async def _log(actor: str, key: str, old: Any, new: Any) -> None:
    async with global_tx("service") as s:
        s.add(
            ConfigChange(
                workspace_id=None, scope="agent", key=key, old_value=old, new_value=new, actor=actor
            )
        )


async def create_version(actor: str, key: str, body: str, notes: str) -> dict[str, Any]:
    if len(body.strip()) < 40:
        raise Invalid("a prompt needs real instructions (at least 40 characters)")
    async with global_tx("service") as s:
        agent = await s.get(Agent, key)
        if agent is None:
            raise NotFound("agent")
        latest = await s.scalar(
            select(func.max(AgentPrompt.version)).where(AgentPrompt.agent_key == key)
        )
        version = int(latest or 0) + 1
        s.add(
            AgentPrompt(
                agent_key=key,
                version=version,
                body=body.strip(),
                notes=notes.strip(),
                created_by=actor,
            )
        )
    await _log(actor, f"{key}.version", None, version)
    return {"status": "ok", "version": version}


async def update_agent(actor: str, key: str, changes: dict[str, Any]) -> dict[str, Any]:
    async with global_tx("service") as s:
        agent = await s.get(Agent, key)
        if agent is None:
            raise NotFound("agent")
        before = {
            "active_version": agent.active_version,
            "model_override": agent.model_override,
            "use_examples": agent.use_examples,
        }
        if "active_version" in changes:
            version = int(changes["active_version"])
            if await s.get(AgentPrompt, (key, version)) is None:
                raise Invalid(f"{key} has no version {version}")
            agent.active_version = version
        if "model_override" in changes:
            override = (changes["model_override"] or "").strip() or None
            if override:
                provider, _, model = override.partition("/")
                if error := validate_choice(provider, model):
                    raise Invalid(error)
            agent.model_override = override
        if "use_examples" in changes:
            agent.use_examples = bool(changes["use_examples"])
        after = {
            "active_version": agent.active_version,
            "model_override": agent.model_override,
            "use_examples": agent.use_examples,
        }
    await _log(actor, key, before, after)
    return {"status": "ok", **after}


def _draft_view(draft: Any, reasons: list[str]) -> dict[str, Any]:
    return {
        "title": draft.title,
        "what": draft.what,
        "so_what": draft.so_what,
        "now_what": draft.now_what,
        "reasons": reasons,
    }


async def evaluate(key: str, version: int, tenant_id: uuid.UUID, samples: int) -> dict[str, Any]:
    """Replay a card writer version on the latest real prompts of one workspace and validate the
    cards exactly as ingest would, next to what the active version produced. Spends tokens."""
    from app.domain import card_quality
    from app.services import pipeline  # avoid an import cycle at module load

    samples = max(1, min(samples, 5))
    async with global_tx("service") as s:
        agent = await s.get(Agent, key)
        candidate = await s.get(AgentPrompt, (key, version))
    if agent is None or candidate is None:
        raise NotFound("agent version")
    if agent.kind != "card_writer":
        raise Invalid("only card writers can be replayed on past runs")
    async with tenant_tx("service", tenant_id) as s:
        calls = (
            await s.scalars(
                select(LlmCallLog)
                .where(LlmCallLog.agent_key == key, LlmCallLog.status == "ok")
                .order_by(LlmCallLog.created_at.desc())
                .limit(samples)
            )
        ).all()
        choice = await _choice(s, agent)
        cases = []
        for call in calls:
            selected = await repo.selected_signals(s, call.run_id, call.role_node_id)
            signals = {str(sig.id): sig for sig, _k in selected}
            if not signals:
                continue
            profile, _ = await pipeline._profile(s, call.role_node_id)
            ctx = await pipeline.validation_context(
                s, call.role_node_id, profile, signals, frozenset()
            )
            role = await s.get(RoleNode, call.role_node_id)
            cases.append((call, selected, profile, ctx, role.title if role else ""))
    if not cases:
        raise Conflict("no past calls of this agent in that workspace yet: run the pipeline first")

    results: list[dict[str, Any]] = []
    totals: defaultdict[str, int] = defaultdict(int)
    client = get_llm(choice.provider, choice.model)
    for call, selected, profile, ctx, role_title in cases:
        before = pipeline.check_drafts(parse_raw(call.response or '{"cards": []}').cards, ctx)
        prompt = Prompt(candidate.body, call.prompt["user"])
        res = await client.generate(
            prompt, [pipeline._prompt_signal(sig, k) for sig, k in selected], profile
        )
        after = pipeline.check_drafts(res.batch.cards if res.batch else [], ctx)
        for label, checked in (("baseline", before), ("candidate", after)):
            totals[f"{label}_cards"] += len(checked)
            totals[f"{label}_valid"] += sum(1 for _d, r in checked if not r)
        totals["tokens"] += res.input_tokens + res.output_tokens
        results.append(
            {
                "role": role_title,
                "run_id": str(call.run_id),
                "error": res.error,
                "baseline": [_draft_view(d, r) for d, r in before],
                "candidate": [_draft_view(d, r) for d, r in after],
            }
        )
    for label in ("baseline", "candidate"):
        cards = [c for case in results for c in case[label] if not c["reasons"]]
        totals[f"{label}_readability"] = card_quality.score_cards(cards)["average"]
    log.info("agent.evaluated", agent=key, version=version, **totals)
    return {
        "agent": key,
        "version": version,
        "active_version": agent.active_version,
        "model": f"{choice.provider}/{choice.model}",
        "evaluated_at": datetime.now(UTC).isoformat(),
        "totals": dict(totals),
        "cases": results,
    }
