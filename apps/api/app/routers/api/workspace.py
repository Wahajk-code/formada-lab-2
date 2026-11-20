"""Client workspace settings: people, workspace roles, assignments, invites (ADR 0021)."""

import uuid
from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.core.auth import CurrentPrincipal
from app.services import access

router = APIRouter(prefix="/workspace", tags=["workspace"])


class AssignmentIn(BaseModel):
    role_node_id: str
    permission: Literal["owner", "viewer"] = "owner"


class InviteIn(BaseModel):
    email: str = Field(max_length=320)
    name: str = Field(default="", max_length=200)
    app_role: Literal["owner", "admin", "member"] = "member"
    locale: Literal["en", "fr"] = "en"
    assignments: list[AssignmentIn] = []


class RoleIn(BaseModel):
    app_role: Literal["owner", "admin", "member"]


class WorkspaceIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    locale: Literal["en", "fr"] | None = None
    timezone: str | None = Field(default=None, max_length=64)
    hide_cards_from_roleless_admins: bool | None = None


@router.get("/people")
async def people(principal: CurrentPrincipal) -> dict[str, Any]:
    return await access.people_view(principal)


@router.post("/invites")
async def invite(body: InviteIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await access.invite(
        principal, body.email, body.name, body.app_role, body.locale,
        [a.model_dump() for a in body.assignments],
    )  # fmt: skip


@router.post("/invites/{invite_id}/resend")
async def resend(invite_id: uuid.UUID, principal: CurrentPrincipal) -> dict[str, Any]:
    return await access.resend_invite(principal, invite_id)


@router.delete("/invites/{invite_id}")
async def revoke(invite_id: uuid.UUID, principal: CurrentPrincipal) -> dict[str, Any]:
    return await access.revoke_invite(principal, invite_id)


@router.put("/people/{person_id}/role")
async def set_role(
    person_id: uuid.UUID, body: RoleIn, principal: CurrentPrincipal
) -> dict[str, Any]:
    return await access.set_role(principal, person_id, body.app_role)


@router.put("/people/{person_id}/assignments")
async def set_assignments(
    person_id: uuid.UUID, body: list[AssignmentIn], principal: CurrentPrincipal
) -> dict[str, Any]:
    return await access.set_assignments(principal, person_id, [a.model_dump() for a in body])


@router.delete("/people/{person_id}")
async def remove(person_id: uuid.UUID, principal: CurrentPrincipal) -> dict[str, Any]:
    return await access.remove_person(principal, person_id)


@router.patch("")
async def update(body: WorkspaceIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await access.update_workspace(principal, body.model_dump(exclude_none=True))
