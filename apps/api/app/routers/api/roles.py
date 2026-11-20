import uuid

from fastapi import APIRouter

from app.routers.api.deps import LivePrincipal
from app.schemas.cards import CardOut, RoleCardsOut
from app.services import cards as card_service

router = APIRouter(prefix="/roles", tags=["roles"])


@router.get("/{role_id}/cards")
async def role_cards(role_id: uuid.UUID, principal: LivePrincipal) -> RoleCardsOut:
    result = await card_service.role_cards(principal, role_id)
    return RoleCardsOut(
        role_node_id=role_id,
        cards=[CardOut.model_validate(c) for c in result.cards],
        rollup=[CardOut.model_validate(c) for c in result.rollup],
    )
