"""Sign-in, password reset, invites (ADR 0021, 0023). The dev shortcuts exist only in ENV=local."""

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from app.core.auth import CurrentPrincipal, TokenAuth, get_auth
from app.core.settings import get_settings
from app.services import access as access_service
from app.services import auth as auth_service
from app.services import org as org_service

router = APIRouter(prefix="/auth", tags=["auth"])
Auth = Annotated[TokenAuth, Depends(get_auth)]


def _local_only() -> None:
    if get_settings().env != "local":
        raise HTTPException(status.HTTP_404_NOT_FOUND)


class SignInIn(BaseModel):
    email: str = Field(max_length=320)
    password: str = Field(max_length=200)


class EmailIn(BaseModel):
    email: str = Field(max_length=320)


class ResetRequestIn(EmailIn):
    kind: Literal["person", "staff"] = "person"


class PasswordIn(BaseModel):
    password: str = Field(max_length=200)


class ChangeIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


class AcceptIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    password: str = Field(max_length=200)


class TokenOut(BaseModel):
    token: str


@router.get("/config")
async def auth_config() -> dict[str, Any]:
    """What the sign-in page offers. Dev shortcuts only exist locally."""
    return {"dev_login": get_settings().env == "local"}


@router.post("/login")
async def login(body: SignInIn, auth: Auth) -> TokenOut:
    return TokenOut(token=await auth_service.sign_in(auth, body.email, body.password))


@router.post("/staff-login")
async def staff_login(body: SignInIn, auth: Auth) -> TokenOut:
    return TokenOut(token=await auth_service.staff_sign_in(auth, body.email, body.password))


@router.post("/password-reset")
async def request_reset(body: ResetRequestIn) -> dict[str, Any]:
    """Always answers "sent": it never reveals whether the email has an account."""
    return await auth_service.request_reset(body.kind, body.email)


@router.post("/password-reset/{token}")
async def reset(token: str, body: PasswordIn) -> dict[str, Any]:
    return await auth_service.reset_password(token, body.password)


@router.post("/change-password")
async def change_password(body: ChangeIn, principal: CurrentPrincipal, auth: Auth) -> TokenOut:
    """Ends every other session; returns a new token for this one."""
    token = await auth_service.change_password(
        auth, "person", principal.email, body.current, body.new
    )
    return TokenOut(token=token)


@router.post("/sign-out-everywhere")
async def sign_out_everywhere(principal: CurrentPrincipal) -> dict[str, Any]:
    return await auth_service.sign_out_everywhere("person", principal.email)


@router.get("/invites/{token}")
async def invite_info(token: str) -> dict[str, Any]:
    """Public: what an invite link is for (workspace, email, role). No session needed."""
    return await access_service.invite_info(token)


@router.post("/invites/{token}/accept")
async def accept_invite(token: str, body: AcceptIn, auth: Auth) -> TokenOut:
    """Public: creates the person, their assignments and password, then signs them in."""
    identity = await access_service.accept_invite(token, body.name, body.password)
    return TokenOut(token=auth.person_token(identity))


# ---- local development shortcuts (no password) ------------------------------------------------


@router.get("/dev-users", dependencies=[Depends(_local_only)])
async def dev_users() -> list[dict[str, Any]]:
    return await org_service.dev_users()


@router.post("/dev-login", dependencies=[Depends(_local_only)])
async def dev_login(body: EmailIn, auth: Auth) -> TokenOut:
    return TokenOut(token=await auth.dev_person_token(body.email))


@router.get("/dev-staff", dependencies=[Depends(_local_only)])
async def dev_staff() -> list[dict[str, Any]]:
    return await access_service.dev_staff()


@router.post("/dev-staff-login", dependencies=[Depends(_local_only)])
async def dev_staff_login(body: EmailIn, auth: Auth) -> TokenOut:
    return TokenOut(token=await auth.dev_staff_token(body.email))
