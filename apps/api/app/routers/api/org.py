from typing import Any

from fastapi import APIRouter

from app.core.auth import CurrentPrincipal
from app.routers.api.deps import LivePrincipal
from app.services import org as org_service

router = APIRouter(tags=["org"])


@router.get("/me")
async def me(principal: CurrentPrincipal) -> dict[str, Any]:
    return await org_service.me(principal)


@router.get("/org")
async def org(principal: LivePrincipal) -> dict[str, Any]:
    """Departments, role nodes and edges visible to the caller (spec: GET /api/org)."""
    return await org_service.org_web(principal)
