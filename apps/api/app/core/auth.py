"""Session tokens for in-app sign-in (ADR 0023).

Passwords are checked in services/auth.py; this module issues and verifies the signed session
tokens (HS256 JWT) and turns them into a Principal (a workspace person) or a StaffPrincipal
(internal team). Every token carries the account's token_version: bumping it (password change,
"sign out everywhere", deactivation) invalidates every session at once.
"""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from functools import lru_cache
from typing import Annotated, Any

import jwt
import structlog
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select

from app.core.db import global_tx, tenant_tx
from app.core.logging import bind_request_context
from app.core.settings import get_settings
from app.models import LoginIdentity, Person, StaffUser


@dataclass(frozen=True)
class Principal:
    tenant_id: uuid.UUID
    person_id: uuid.UUID
    email: str
    name: str
    app_role: str
    locale: str


@dataclass(frozen=True)
class StaffPrincipal:
    """Internal team member (ADR 0020). Never a person of a workspace."""

    staff_id: uuid.UUID
    email: str
    name: str
    staff_role: str

    @property
    def actor(self) -> str:
        return f"staff:{self.email}"


def _unauthorized(detail: str = "invalid session") -> HTTPException:
    return HTTPException(status.HTTP_401_UNAUTHORIZED, detail)


class TokenAuth:
    ALGORITHM = "HS256"

    def __init__(self, secret: str, ttl_minutes: int) -> None:
        if not secret:
            raise RuntimeError("AUTH_JWT_SECRET is not set")
        self._secret = secret
        self._ttl = timedelta(minutes=ttl_minutes)

    def _encode(self, claims: dict[str, Any]) -> str:
        now = datetime.now(UTC)
        return jwt.encode(
            {**claims, "iat": now, "exp": now + self._ttl}, self._secret, algorithm=self.ALGORITHM
        )

    def _decode(self, token: str, kind: str) -> dict[str, Any]:
        try:
            claims: dict[str, Any] = jwt.decode(token, self._secret, algorithms=[self.ALGORITHM])
        except jwt.PyJWTError as exc:
            raise _unauthorized() from exc
        if claims.get("kind") != kind:
            raise _unauthorized()
        return claims

    # ---- issue -------------------------------------------------------------------------------

    def person_token(self, identity: LoginIdentity) -> str:
        return self._encode(
            {
                "kind": "person",
                "sub": str(identity.person_id),
                "tid": str(identity.tenant_id),
                "sv": identity.token_version,
            }
        )

    def staff_token(self, staff: StaffUser) -> str:
        return self._encode({"kind": "staff", "sub": str(staff.id), "sv": staff.token_version})

    async def dev_person_token(self, email: str) -> str:
        """Local only (the dev sign-in shortcuts): a session without a password."""
        async with global_tx("service") as s:
            identity = await s.scalar(
                select(LoginIdentity).where(LoginIdentity.email == email.lower())
            )
        if identity is None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown user")
        return self.person_token(identity)

    async def dev_staff_token(self, email: str) -> str:
        async with global_tx("service") as s:
            staff = await s.scalar(select(StaffUser).where(StaffUser.email == email.lower()))
        if staff is None or staff.deactivated_at is not None:
            raise HTTPException(status.HTTP_404_NOT_FOUND, "unknown staff user")
        return self.staff_token(staff)

    # ---- verify ------------------------------------------------------------------------------

    async def authenticate(self, token: str) -> Principal:
        claims = self._decode(token, "person")
        try:
            tenant_id, person_id = uuid.UUID(claims["tid"]), uuid.UUID(claims["sub"])
        except (KeyError, ValueError) as exc:
            raise _unauthorized() from exc
        async with global_tx("service") as s:
            version = await s.scalar(
                select(LoginIdentity.token_version).where(LoginIdentity.person_id == person_id)
            )
        if version is None or version != claims.get("sv", 0):
            raise _unauthorized("session ended")  # signed out everywhere, or access removed
        async with tenant_tx("user", tenant_id, person_id) as s:
            person = await s.get(Person, person_id)
        if person is None or person.deactivated_at is not None:
            raise _unauthorized("unknown person")
        return Principal(
            tenant_id=tenant_id,
            person_id=person_id,
            email=person.email,
            name=person.name,
            app_role=person.app_role,
            locale=person.locale,
        )

    async def authenticate_staff(self, token: str) -> StaffPrincipal:
        claims = self._decode(token, "staff")
        try:
            staff_id = uuid.UUID(claims["sub"])
        except (KeyError, ValueError) as exc:
            raise _unauthorized() from exc
        async with global_tx("service") as s:
            staff = await s.get(StaffUser, staff_id)
        if staff is None or staff.deactivated_at is not None:
            raise _unauthorized("unknown staff user")
        if staff.token_version != claims.get("sv", 0):
            raise _unauthorized("session ended")
        return StaffPrincipal(staff.id, staff.email, staff.name, staff.staff_role)


@lru_cache
def get_auth() -> TokenAuth:
    settings = get_settings()
    return TokenAuth(settings.auth_jwt_secret, settings.auth_token_ttl_minutes)


_bearer = HTTPBearer(auto_error=False)


async def current_principal(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    auth: Annotated[TokenAuth, Depends(get_auth)],
) -> Principal:
    if creds is None:
        raise _unauthorized("missing bearer token")
    principal = await auth.authenticate(creds.credentials)
    bind_request_context(tenant_id=str(principal.tenant_id))
    return principal


CurrentPrincipal = Annotated[Principal, Depends(current_principal)]


async def current_staff(
    creds: Annotated[HTTPAuthorizationCredentials | None, Depends(_bearer)],
    auth: Annotated[TokenAuth, Depends(get_auth)],
) -> StaffPrincipal:
    if creds is None:
        raise _unauthorized("missing bearer token")
    staff = await auth.authenticate_staff(creds.credentials)
    structlog.contextvars.bind_contextvars(staff=staff.email, tenant_id=None)
    return staff


CurrentStaff = Annotated[StaffPrincipal, Depends(current_staff)]
