import uuid
from dataclasses import dataclass

from app.core.auth import Principal
from app.core.db import tenant_tx
from app.core.errors import NotFound
from app.domain import org as org_rules
from app.models import InsightCard
from app.repositories import cards as card_repo
from app.repositories import org as org_repo


@dataclass
class RoleCards:
    cards: list[InsightCard]
    rollup: list[InsightCard]


async def role_cards(principal: Principal, role_id: uuid.UUID) -> RoleCards:
    """Open cards owned by a role (its own + routed vacant ones) and the top child cards."""
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        visible = await org_repo.visible_role_ids(s)
        if role_id not in visible:
            raise NotFound("role")
        nodes = await org_repo.nodes(s)
        rules = await org_repo.rules(s)
        owned = org_rules.owned_nodes(nodes, role_id)
        below = org_rules.descendants(nodes, role_id)
        cards = await card_repo.open_cards(s, owned | below)

    by_id = {c.id: c for c in cards}
    top = org_rules.rollup(
        nodes,
        role_id,
        (org_rules.CardRef(c.id, c.role_node_id, c.expected_impact) for c in cards),
        rules.rollup_top_n,
    )
    own = [c for c in cards if c.role_node_id in owned][: rules.max_open_cards_per_role]
    return RoleCards(cards=own, rollup=[by_id[r.id] for r in top])


async def one_card(principal: Principal, card_id: uuid.UUID) -> InsightCard:
    """One card with its evidence, for the history and initiative details. Row-level security and
    the visible-roles check keep it to cards this person may see."""
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        visible = await org_repo.visible_role_ids(s)
        card = await s.get(InsightCard, card_id)
        if card is None or card.role_node_id not in visible:
            raise NotFound("card")
        return card
