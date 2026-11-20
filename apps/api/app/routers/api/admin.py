import uuid
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.auth import CurrentPrincipal, Principal
from app.domain.access import is_admin
from app.integrations import n8n
from app.services import feedback as feedback_service
from app.services import insights

router = APIRouter(prefix="/admin", tags=["admin"])


def _admin(principal: CurrentPrincipal) -> Principal:
    if not is_admin(principal.app_role):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "owners and admins only")
    return principal


Admin = Annotated[Principal, Depends(_admin)]


class RuleReview(BaseModel):
    action: Literal["accept", "reject", "retire"]
    text: str | None = Field(default=None, max_length=500)


@router.get("/rules")
async def rules(principal: Admin) -> dict[str, Any]:
    """Review queue and active rules (spec: GET /api/rules, admin and reviewers)."""
    return await feedback_service.rules_view(principal)


@router.patch("/rules/{rule_id}")
async def review_rule(rule_id: uuid.UUID, body: RuleReview, principal: Admin) -> dict[str, Any]:
    return await feedback_service.review_rule(principal, rule_id, body.action, body.text)


@router.get("/usage")
async def usage(principal: Admin) -> dict[str, Any]:
    """Warehouse credits and LLM tokens against the caps, runs and the workflow schedule."""
    return await insights.usage(principal)


@router.post("/runs")
async def run_now(principal: Admin) -> dict[str, Any]:
    """Trigger a weekly run for this tenant now (spec: POST /api/runs) through WF1."""
    started = await n8n.run_now(principal.tenant_id)
    if not started:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "n8n is not reachable")
    return {"status": "started"}
