"""Card actions (spec: POST /api/cards/:id/action and /feedback), initiatives, ledger, history."""

import uuid
from datetime import date
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.routers.api.deps import LivePrincipal
from app.schemas.cards import CardOut
from app.services import agents, insights
from app.services import cards as card_service
from app.services import feedback as feedback_service

router = APIRouter(tags=["cards"])


class FeedbackIn(BaseModel):
    type: Literal["not_relevant", "impossible"]
    reason: str | None = Field(default=None, max_length=500)


class ActionIn(BaseModel):
    baseline_value: float | None = None
    baseline_period: str | None = Field(default=None, max_length=80)
    window_days: int | None = Field(default=None, ge=1, le=365)
    target_value: float | None = None
    due_date: date | None = None


class DecisionIn(BaseModel):
    choice: Literal["keep", "stop"]


@router.get("/cards/{card_id}")
async def one_card(card_id: uuid.UUID, principal: LivePrincipal) -> CardOut:
    """One card in full (history and initiative details)."""
    return CardOut.model_validate(await card_service.one_card(principal, card_id))


@router.get("/cards/{card_id}/action")
async def action_defaults(card_id: uuid.UUID, principal: LivePrincipal) -> dict[str, Any]:
    """Prefill for the Action this dialog."""
    return await feedback_service.action_defaults(principal, card_id)


@router.post("/cards/{card_id}/action")
async def action(card_id: uuid.UUID, body: ActionIn, principal: LivePrincipal) -> dict[str, Any]:
    return await feedback_service.action_card(
        principal, card_id, body.baseline_value, body.baseline_period, body.window_days,
        body.target_value, body.due_date,
    )  # fmt: skip


@router.post("/cards/{card_id}/feedback")
async def feedback(
    card_id: uuid.UUID, body: FeedbackIn, principal: LivePrincipal
) -> dict[str, Any]:
    return await feedback_service.give_feedback(principal, card_id, body.type, body.reason)


@router.post("/cards/{card_id}/translate")
async def translate(
    card_id: uuid.UUID, principal: LivePrincipal, language: Literal["en", "fr"] = "en"
) -> dict[str, Any]:
    """On-demand translation by the translator agent, cached per card and language."""
    return await agents.translate_card(principal, card_id, language)


@router.post("/initiatives/{initiative_id}/decision")
async def decision(
    initiative_id: uuid.UUID, body: DecisionIn, principal: LivePrincipal
) -> dict[str, Any]:
    return await feedback_service.decide(principal, initiative_id, body.choice)


@router.get("/dashboard")
async def dashboard(principal: LivePrincipal) -> dict[str, Any]:
    return await insights.dashboard(principal)


@router.get("/ledger")
async def ledger(principal: LivePrincipal) -> dict[str, Any]:
    """Value captured by role, department and company, with every initiative."""
    return await insights.ledger(principal)


@router.get("/history")
async def history(
    principal: LivePrincipal,
    role_id: Annotated[uuid.UUID | None, Query()] = None,
    status: Annotated[str | None, Query(max_length=15)] = None,
) -> dict[str, Any]:
    """Every card and its fate, filterable by role and status."""
    return await insights.history(principal, role_id, status)
