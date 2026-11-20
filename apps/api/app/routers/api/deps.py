"""Router dependencies shared by the client app routers."""

from typing import Annotated

from fastapi import Depends, HTTPException, status

from app.core.auth import CurrentPrincipal, Principal
from app.services import org as org_service


async def live_principal(principal: CurrentPrincipal) -> Principal:
    """Cards, the org web, the ledger and history open when the workspace goes live (ADR 0027)."""
    if await org_service.lifecycle(principal) == "onboarding":
        raise HTTPException(status.HTTP_409_CONFLICT, "the workspace is still onboarding")
    return principal


LivePrincipal = Annotated[Principal, Depends(live_principal)]
