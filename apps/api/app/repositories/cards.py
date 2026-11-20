import uuid
from collections.abc import Collection, Sequence

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import InsightCard


async def open_cards(
    session: AsyncSession, role_node_ids: Collection[uuid.UUID]
) -> Sequence[InsightCard]:
    rows = await session.scalars(
        select(InsightCard)
        .where(InsightCard.status == "open", InsightCard.role_node_id.in_(role_node_ids))
        .order_by(InsightCard.priority, InsightCard.expected_impact.desc())
    )
    return rows.all()
