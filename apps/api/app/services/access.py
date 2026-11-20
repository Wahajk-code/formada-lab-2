"""Client workspace access: people, workspace roles, role-node assignments, invites (ADR 0021).

User actions run as app_user, so RLS backs every check here (only owners and admins may write
people, assignments, invites and workspace settings). Accepting an invite has no session yet:
it runs through the service connection, scoped to the workspace named in the invite link.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from sqlalchemy import delete, func, select

from app.core.auth import Principal
from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.logging import get_logger
from app.core.passwords import hash_password
from app.core.settings import get_settings
from app.domain import access as rules_access
from app.domain import auth as rules_auth
from app.integrations import email
from app.models import (
    AuditLog,
    Department,
    Invite,
    LoginIdentity,
    Person,
    RoleAssignment,
    RoleNode,
    StaffUser,
    Tenant,
)
from app.repositories import org as org_repo

log = get_logger(__name__)


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _audit(
    tenant_id: uuid.UUID, actor: str, action: str, obj: str, obj_id: Any, **detail: Any
) -> AuditLog:
    return AuditLog(
        tenant_id=tenant_id,
        actor=actor,
        action=action,
        object_type=obj,
        object_id=str(obj_id),
        detail=detail,
    )


async def dev_staff() -> list[dict[str, Any]]:
    async with global_tx("service") as s:
        rows = (await s.scalars(select(StaffUser).order_by(StaffUser.name))).all()
    return [{"email": r.email, "name": r.name, "staff_role": r.staff_role} for r in rows]


async def _me(s: Any, principal: Principal) -> Person:
    me: Person | None = await s.get(Person, principal.person_id)
    if me is None:
        raise NotFound("person")
    return me


async def _require_admin(s: Any, principal: Principal) -> Person:
    me = await _me(s, principal)
    if not rules_access.is_admin(me.app_role):
        raise Forbidden("only workspace owners and admins can manage people")
    return me


async def _owners(s: Any) -> int:
    count = await s.scalar(
        select(func.count()).where(Person.app_role == "owner", Person.deactivated_at.is_(None))
    )
    return int(count or 0)


# ---------------------------------------------------------------------------------------------
# Read
# ---------------------------------------------------------------------------------------------


async def people_view(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _require_admin(s, principal)
        people = (await s.scalars(select(Person).order_by(Person.name))).all()
        assignments = (await s.scalars(select(RoleAssignment))).all()
        roles = (
            await s.execute(
                select(RoleNode.id, RoleNode.title, RoleNode.holder_type, Department.name)
                .outerjoin(Department, Department.id == RoleNode.department_id)
                .order_by(Department.sort_order.nulls_first(), RoleNode.title)
            )
        ).all()
        invites = (await s.scalars(select(Invite).order_by(Invite.created_at.desc()))).all()
        tenant = await s.get(Tenant, principal.tenant_id)
    titles = {r.id: r.title for r in roles}
    now = datetime.now(UTC)
    return {
        "me": {"id": str(me.id), "app_role": me.app_role},
        "workspace": {
            "name": tenant.name if tenant else "",
            "locale": tenant.locale if tenant else "en",
            "timezone": tenant.timezone if tenant else "UTC",
            "hide_cards_from_roleless_admins": tenant.hide_cards_from_roleless_admins
            if tenant
            else False,
        },
        "people": [
            {
                "id": str(p.id),
                "name": p.name,
                "email": p.email,
                "app_role": p.app_role,
                "locale": p.locale,
                "active": p.deactivated_at is None,
                "is_me": p.id == me.id,
                "assignments": [
                    {
                        "role_node_id": str(a.role_node_id),
                        "title": titles.get(a.role_node_id, ""),
                        "permission": a.permission,
                    }
                    for a in assignments
                    if a.person_id == p.id and a.grant_effect == "allow"
                ],
            }
            for p in people
        ],
        "roles": [
            {
                "id": str(r.id),
                "title": r.title,
                "department": r.name,
                "vacant": r.holder_type == "vacant",
            }
            for r in roles
        ],
        "invites": [
            {
                "id": str(i.id),
                "email": i.email,
                "name": i.name,
                "app_role": i.app_role,
                "status": "expired" if i.status == "pending" and i.expires_at < now else i.status,
                "expires_at": i.expires_at.isoformat(),
                "created_at": i.created_at.isoformat(),
                "assignments": [
                    {**a, "title": titles.get(uuid.UUID(a["role_node_id"]), "")}
                    for a in i.assignments
                ],
            }
            for i in invites
        ],
    }


# ---------------------------------------------------------------------------------------------
# Invites
# ---------------------------------------------------------------------------------------------


def _parse_assignments(raw: list[dict[str, str]], known: set[str]) -> list[dict[str, str]]:
    pairs = [(str(a.get("role_node_id", "")), str(a.get("permission", "owner"))) for a in raw]
    if error := rules_access.check_assignments(pairs, known):
        raise Invalid(error)
    return [{"role_node_id": r, "permission": p} for r, p in pairs]


async def _send_invite(
    tenant_name: str, inv_email: str, name: str, locale: str, token: str
) -> None:
    link = f"{get_settings().app_base_url}/invite/{token}"
    if locale == "fr":
        subject = f"Invitation à {tenant_name} sur Formada"
        intro = f"Vous êtes invité·e à rejoindre {tenant_name} sur Formada."
        text = f"Bonjour {name},\n\n{intro}\n{link}\n"
    else:
        subject = f"You are invited to {tenant_name} on Formada"
        intro = f"You have been invited to join {tenant_name} on Formada."
        text = f"Hello {name},\n\n{intro}\n{link}\n"
    first, intro_line = text.splitlines()[0], text.splitlines()[2]
    html = f'<p>{first}</p><p>{intro_line}</p><p><a href="{link}">{link}</a></p>'
    await email.send(email.Mail(inv_email, subject, text, html))


def _new_token(tenant_id: uuid.UUID) -> str:
    # The workspace id travels in the link so acceptance can open the right tenant context.
    return f"{tenant_id.hex}.{secrets.token_urlsafe(24)}"


async def invite(
    principal: Principal,
    to: str,
    name: str,
    app_role: str,
    locale: str,
    assignments: list[dict[str, str]],
) -> dict[str, Any]:
    to = to.strip().lower()
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _require_admin(s, principal)
        if error := rules_access.check_invite(me.app_role, to, app_role):
            raise Invalid(error)
        known = {str(r) for r in await s.scalars(select(RoleNode.id))}
        clean = _parse_assignments(assignments, known)
        if await s.scalar(
            select(Person.id).where(Person.email == to, Person.deactivated_at.is_(None))
        ):
            raise Conflict("this person is already in the workspace")
        if await s.scalar(
            select(Invite.id).where(
                Invite.email == to, Invite.status == "pending", Invite.expires_at > func.now()
            )
        ):
            raise Conflict("an invite to this address is already pending")
        rules = await org_repo.rules(s)
        token = _new_token(principal.tenant_id)
        inv = Invite(
            tenant_id=principal.tenant_id,
            email=to,
            name=name.strip() or to.split("@")[0],
            app_role=app_role,
            locale=locale if locale in ("en", "fr") else "en",
            assignments=clean,
            token_hash=_hash(token),
            invited_by=me.id,
            expires_at=datetime.now(UTC) + timedelta(days=rules.invite_valid_days),
        )
        s.add(inv)
        await s.flush()
        s.add(
            _audit(
                principal.tenant_id,
                principal.email,
                "invite.sent",
                "invite",
                inv.id,
                email=to,
                role=app_role,
            )
        )
        tenant = await s.get(Tenant, principal.tenant_id)
        invite_id = inv.id
    await _send_invite(tenant.name if tenant else "", to, inv.name, inv.locale, token)
    out: dict[str, Any] = {"status": "sent", "invite_id": str(invite_id)}
    if get_settings().env == "local":
        out["link"] = f"{get_settings().app_base_url}/invite/{token}"  # dev convenience only
    return out


async def resend_invite(principal: Principal, invite_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        await _require_admin(s, principal)
        inv = await s.get(Invite, invite_id)
        if inv is None:
            raise NotFound("invite")
        if inv.status != "pending":
            raise Conflict(f"invite is {inv.status}")
        rules = await org_repo.rules(s)
        token = _new_token(principal.tenant_id)
        inv.token_hash = _hash(token)
        inv.expires_at = datetime.now(UTC) + timedelta(days=rules.invite_valid_days)
        s.add(_audit(principal.tenant_id, principal.email, "invite.resent", "invite", inv.id))
        tenant = await s.get(Tenant, principal.tenant_id)
        to, name, locale = inv.email, inv.name, inv.locale
    await _send_invite(tenant.name if tenant else "", to, name, locale, token)
    out: dict[str, Any] = {"status": "sent"}
    if get_settings().env == "local":
        out["link"] = f"{get_settings().app_base_url}/invite/{token}"
    return out


async def revoke_invite(principal: Principal, invite_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        await _require_admin(s, principal)
        inv = await s.get(Invite, invite_id)
        if inv is None:
            raise NotFound("invite")
        if inv.status != "pending":
            raise Conflict(f"invite is {inv.status}")
        inv.status = "revoked"
        s.add(_audit(principal.tenant_id, principal.email, "invite.revoked", "invite", inv.id))
    return {"status": "revoked"}


def _tenant_of(token: str) -> uuid.UUID:
    try:
        return uuid.UUID(hex=token.split(".", 1)[0])
    except ValueError as exc:
        raise NotFound("invite") from exc


async def _pending(s: Any, token: str) -> Invite:
    inv: Invite | None = await s.scalar(select(Invite).where(Invite.token_hash == _hash(token)))
    if inv is None or inv.status != "pending" or inv.expires_at < datetime.now(UTC):
        raise NotFound("invite")  # unknown, used, revoked and expired all look the same
    return inv


async def invite_info(token: str) -> dict[str, Any]:
    tenant_id = _tenant_of(token)
    async with tenant_tx("service", tenant_id) as s:
        inv = await _pending(s, token)
        tenant = await s.get(Tenant, tenant_id)
    return {
        "workspace": tenant.name if tenant else "",
        "email": inv.email,
        "name": inv.name,
        "app_role": inv.app_role,
        "locale": inv.locale,
        "roles": len(inv.assignments),
    }


async def accept_invite(token: str, name: str | None, password: str) -> LoginIdentity:
    """Creates the person, their assignments and their login with a first password (ADR 0023).
    Returns the login identity, so the caller can sign them in."""
    tenant_id = _tenant_of(token)
    async with tenant_tx("service", tenant_id) as s:
        inv = await _pending(s, token)
        address = inv.email
        rules = await org_repo.rules(s)
    if error := rules_auth.check_password(password, address, rules):
        raise Invalid(error)
    async with global_tx("service") as s:
        taken = await s.scalar(select(LoginIdentity).where(LoginIdentity.email == address))
    if taken is not None and taken.tenant_id != tenant_id:
        raise Conflict("this email already signs in to another workspace")
    async with tenant_tx("service", tenant_id) as s:
        inv = await _pending(s, token)
        known = {str(r) for r in await s.scalars(select(RoleNode.id))}
        person = await s.scalar(select(Person).where(Person.email == inv.email))
        if person is None:
            person = Person(
                tenant_id=tenant_id,
                email=inv.email,
                name=(name or inv.name).strip()[:200],
                app_role=inv.app_role,
                locale=inv.locale,
            )
            s.add(person)
        else:  # a removed person coming back
            person.deactivated_at, person.app_role = None, inv.app_role
        await s.flush()
        for a in inv.assignments:
            if a["role_node_id"] in known:
                s.add(
                    RoleAssignment(
                        tenant_id=tenant_id,
                        person_id=person.id,
                        role_node_id=uuid.UUID(a["role_node_id"]),
                        permission=a["permission"],
                        is_primary=True,
                    )
                )
        inv.status, inv.accepted_at = "accepted", datetime.now(UTC)
        s.add(_audit(tenant_id, inv.email, "invite.accepted", "person", person.id))
        person_id = person.id
    async with global_tx("service") as s:
        identity = await s.scalar(select(LoginIdentity).where(LoginIdentity.email == address))
        if identity is None:
            identity = LoginIdentity(email=address, tenant_id=tenant_id, person_id=person_id)
            s.add(identity)
        identity.person_id = person_id
        identity.password_hash = hash_password(password)
        identity.failed_attempts, identity.locked_until = 0, None
        await s.flush()
    log.info("invite.accepted", tenant_id=str(tenant_id))
    return identity


# ---------------------------------------------------------------------------------------------
# People
# ---------------------------------------------------------------------------------------------


async def set_role(principal: Principal, person_id: uuid.UUID, role: str) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _require_admin(s, principal)
        target = await s.get(Person, person_id)
        if target is None or target.deactivated_at is not None:
            raise NotFound("person")
        if error := rules_access.check_role_change(
            me.app_role, target.app_role, role, await _owners(s)
        ):
            raise Invalid(error)
        old, target.app_role = target.app_role, role
        s.add(
            _audit(
                principal.tenant_id,
                principal.email,
                "person.role",
                "person",
                target.id,
                old=old,
                new=role,
            )
        )
    return {"status": "ok", "app_role": role}


async def set_assignments(
    principal: Principal, person_id: uuid.UUID, assignments: list[dict[str, str]]
) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        await _require_admin(s, principal)
        target = await s.get(Person, person_id)
        if target is None or target.deactivated_at is not None:
            raise NotFound("person")
        known = {str(r) for r in await s.scalars(select(RoleNode.id))}
        clean = _parse_assignments(assignments, known)
        await s.execute(
            delete(RoleAssignment).where(
                RoleAssignment.person_id == person_id, RoleAssignment.grant_effect == "allow"
            )
        )
        for a in clean:
            s.add(
                RoleAssignment(
                    tenant_id=principal.tenant_id,
                    person_id=person_id,
                    role_node_id=uuid.UUID(a["role_node_id"]),
                    permission=a["permission"],
                    is_primary=True,
                )
            )
        s.add(
            _audit(
                principal.tenant_id,
                principal.email,
                "person.assignments",
                "person",
                person_id,
                assignments=clean,
            )
        )
    return {"status": "ok", "assignments": clean}


async def remove_person(principal: Principal, person_id: uuid.UUID) -> dict[str, Any]:
    """Deactivate: the person can no longer sign in or see anything; their history stays."""
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        me = await _require_admin(s, principal)
        target = await s.get(Person, person_id)
        if target is None or target.deactivated_at is not None:
            raise NotFound("person")
        error = rules_access.check_removal(
            me.app_role, target.app_role, await _owners(s), target.id == me.id
        )
        if error:
            raise Invalid(error)
        target.deactivated_at = datetime.now(UTC)
        await s.execute(delete(RoleAssignment).where(RoleAssignment.person_id == person_id))
        s.add(_audit(principal.tenant_id, principal.email, "person.removed", "person", person_id))
    async with global_tx("service") as s:
        await s.execute(delete(LoginIdentity).where(LoginIdentity.person_id == person_id))
    return {"status": "removed"}


async def update_workspace(principal: Principal, changes: dict[str, Any]) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        await _require_admin(s, principal)
        tenant = await s.get(Tenant, principal.tenant_id)
        assert tenant is not None
        if "name" in changes:
            if not str(changes["name"]).strip():
                raise Invalid("the workspace needs a name")
            tenant.name = str(changes["name"]).strip()[:200]
        if "locale" in changes:
            if changes["locale"] not in ("en", "fr"):
                raise Invalid("locale must be en or fr")
            tenant.locale = changes["locale"]
        if "timezone" in changes:
            try:
                ZoneInfo(str(changes["timezone"]))
            except (ZoneInfoNotFoundError, ValueError) as exc:
                raise Invalid("unknown time zone") from exc
            tenant.timezone = str(changes["timezone"])
        if "hide_cards_from_roleless_admins" in changes:
            tenant.hide_cards_from_roleless_admins = bool(
                changes["hide_cards_from_roleless_admins"]
            )
        s.add(
            _audit(
                principal.tenant_id,
                principal.email,
                "workspace.updated",
                "tenant",
                tenant.id,
                **changes,
            )
        )
    return {"status": "ok"}
