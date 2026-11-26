"""One trial card written again, on the team's instruction.

The card writer sees the same prompt as in a run (the role, the playbook, the active rules and the
card's own signal) plus what the team wants changed. The new text passes the same checks as any
card; if it fails them, the card is left as it was and the reasons are returned.
"""

import uuid
from typing import Any

from sqlalchemy import select

from app.core.db import tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.logging import get_logger
from app.domain.card_validation import fit_title, group_numbers
from app.domain.llm import validate_choice
from app.domain.prompting import (
    REWRITE_LIMIT,
    ActiveRule,
    Prompt,
    build_prompt,
    rewrite_block,
)
from app.integrations.llm import get_llm
from app.models import AuditLog, InsightCard, Metric, Signal
from app.repositories import agents as agent_repo
from app.repositories import pipeline as repo
from app.services import pipeline
from app.services.llm_settings import Choice, effective_choice

log = get_logger(__name__)


async def regenerate_card(
    actor: str, tenant_id: uuid.UUID, card_id: uuid.UUID, instruction: str
) -> dict[str, Any]:
    """Write one open card again as instructed. Only the words change: the signal, the numbers
    and the impact stay as the code measured them."""
    instruction = instruction.strip()
    if not instruction:
        raise Invalid("say what should change")
    if len(instruction) > REWRITE_LIMIT:
        raise Invalid(f"keep it under {REWRITE_LIMIT} characters")
    async with tenant_tx("service", tenant_id) as s:
        card = await s.get(InsightCard, card_id)
        if card is None:
            raise NotFound("card")
        if card.status != "open" or card.signal_id is None:
            raise Conflict("only an open card that comes from a signal can be written again")
        signal = await s.get(Signal, card.signal_id)
        if signal is None:
            raise Conflict("the signal behind this card is gone")
        metric_key = str(await s.scalar(select(Metric.key).where(Metric.id == signal.metric_id)))
        profile, playbook = await pipeline._profile(s, card.role_node_id)
        agent = await agent_repo.active(s, f"card_writer_{playbook}") if playbook else None
        system = agent[1].body if agent else await repo.prompt_body(s, "system")
        base = build_prompt(
            system=system,
            playbook=await repo.prompt_body(s, f"playbook_{playbook}") if playbook else "",
            profile=profile,
            rules=[
                ActiveRule(r.rule_type, r.text)
                for r in await repo.active_rules(s, card.role_node_id)
            ],
            signals=[pipeline._prompt_signal(signal, metric_key)],
        )
        prompt = Prompt(
            base.system,
            base.user
            + "\n\n"
            + rewrite_block(
                {k: str(getattr(card, k)) for k in ("title", "what", "so_what", "now_what")},
                instruction,
            ),
        )
        choice = await effective_choice(s)
        if agent and agent[0].model_override:  # set by the internal team for this agent only
            provider, _, model = agent[0].model_override.partition("/")
            if validate_choice(provider, model):
                choice = Choice(provider, model, "agent")
        ctx = await pipeline.validation_context(
            s, card.role_node_id, profile, {str(signal.id): signal}, frozenset()
        )
        language = profile.language
    result = await get_llm(choice.provider, choice.model).generate(
        prompt, [pipeline._prompt_signal(signal, metric_key)], profile
    )
    if result.batch is None or not result.batch.cards:
        raise Conflict(f"the card writer gave no card: {result.error or 'no answer'}")
    draft = next((d for d in result.batch.cards if d.signal_id == str(signal.id)), None)
    if draft is None:
        raise Conflict("the card writer wrote a card for another signal; nothing changed")
    reasons = pipeline.check_drafts([draft], ctx)[0][1]
    if reasons:
        raise Invalid("the new card was refused, and the card is unchanged: " + "; ".join(reasons))
    fields = {
        "title": fit_title(group_numbers(draft.title, language)),
        "what": group_numbers(draft.what, language),
        "so_what": group_numbers(draft.so_what, language),
        "now_what": group_numbers(draft.now_what, language),
        "decision_used": draft.decision_used,
    }
    async with tenant_tx("service", tenant_id) as s:
        card = await s.get(InsightCard, card_id)
        if card is None or card.status != "open":
            raise Conflict("the card changed while it was being written; nothing was saved")
        before = {k: str(getattr(card, k)) for k in fields}
        for k, v in fields.items():
            setattr(card, k, v)
        card.generated_by = f"{result.provider}/{result.model}"
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=actor,
                action="trial.regenerate",
                object_type="insight_card",
                object_id=str(card.id),
                detail={"instruction": instruction[:REWRITE_LIMIT], "before": before},
            )
        )
    log.info(
        "trial.regenerate",
        card=str(card_id),
        model=result.model,
        tokens=result.input_tokens + result.output_tokens,
    )
    return {
        "status": "ok",
        "card": {"id": str(card_id), **fields},
        "model": f"{result.provider}/{result.model}",
        "tokens": {"input": result.input_tokens, "output": result.output_tokens},
    }
