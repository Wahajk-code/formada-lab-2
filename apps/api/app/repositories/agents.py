"""Agent registry queries (ADR 0022). Agents are platform tables; feedback examples are tenant
data read in the caller's (RLS-scoped) session."""

import uuid
from collections.abc import Sequence
from datetime import datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.agents import PastCard
from app.models import Agent, AgentPrompt, Feedback, InsightCard


async def active(session: AsyncSession, key: str) -> tuple[Agent, AgentPrompt] | None:
    agent = await session.get(Agent, key)
    if agent is None:
        return None
    prompt = await session.get(AgentPrompt, (key, agent.active_version))
    return (agent, prompt) if prompt is not None else None


async def past_cards(
    session: AsyncSession, role_ids: Sequence[uuid.UUID], since: datetime
) -> list[PastCard]:
    rows = await session.execute(
        select(InsightCard, Feedback.reason)
        .outerjoin(Feedback, Feedback.card_id == InsightCard.id)
        .where(
            InsightCard.role_node_id.in_(role_ids),
            InsightCard.status.in_(("actioned", "not_relevant", "impossible")),
            InsightCard.closed_at >= since,
        )
    )
    return [
        PastCard(
            title=card.title,
            now_what=card.now_what,
            status=card.status,
            reason=reason,
            metric_key=str((card.evidence or {}).get("metric_key", "")),
            at=card.closed_at or card.created_at,
        )
        for card, reason in rows.all()
    ]
