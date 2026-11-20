"""In-app sign-in (ADR 0023) and internal staff accounts (ADR 0024).

Everything here runs before or outside a workspace session, so it uses the service connection:
the web session (app_user) can never read a password hash. Failures never reveal whether an email
exists: unknown email, wrong password and locked account all answer the same way.
"""

import hashlib
import secrets
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

from sqlalchemy import func, select

from app.core.auth import TokenAuth
from app.core.db import global_tx, tenant_tx
from app.core.errors import Conflict, Forbidden, Invalid, NotFound
from app.core.logging import get_logger
from app.core.passwords import DUMMY_HASH, hash_password, verify_password
from app.core.settings import get_settings
from app.domain import auth as rules_auth
from app.domain.config import RulesConfig, layered
from app.integrations import email
from app.models import AuditLog, ConfigChange, LoginIdentity, PasswordReset, Person, StaffUser
from app.repositories import org as org_repo

log = get_logger(__name__)
GENERIC = "invalid email or password"


async def _rules(s: Any) -> RulesConfig:
    return layered(await org_repo.system_overrides(s), {})


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


async def _password_ok(s: Any, account: LoginIdentity | StaffUser | None, password: str) -> bool:
    """Shared by people and staff: lockout, constant-time check, attempt counting. Returns
    instead of raising, so the caller's transaction commits the failed-attempt count."""
    now = datetime.now(UTC)
    rules = await _rules(s)
    if account is None:
        verify_password(password, DUMMY_HASH)  # same cost as a real check
        return False
    if rules_auth.is_locked(account.locked_until, now):
        return False
    if not verify_password(password, account.password_hash):
        attempt = rules_auth.after_failure(account.failed_attempts, now, rules)
        account.failed_attempts, account.locked_until = (
            attempt.failed_attempts,
            attempt.locked_until,
        )
        if attempt.locked_until:
            log.warning("auth.locked", account=str(account.id))
        return False
    account.failed_attempts, account.locked_until, account.last_login_at = 0, None, now
    return True


async def sign_in(auth: TokenAuth, address: str, password: str) -> str:
    address = address.strip().lower()
    async with global_tx("service") as s:
        identity = await s.scalar(select(LoginIdentity).where(LoginIdentity.email == address))
        ok = await _password_ok(s, identity, password)
        if ok and identity is not None:
            token = auth.person_token(identity)
            tenant_id, person_id = identity.tenant_id, identity.person_id
    if not ok:
        raise Forbidden(GENERIC)
    async with tenant_tx("service", tenant_id) as s:
        person = await s.get(Person, person_id)
        if person is None or person.deactivated_at is not None:
            raise Forbidden(GENERIC)
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=address,
                action="auth.sign_in",
                object_type="person",
                object_id=str(person_id),
                detail={},
            )
        )
    return token


async def staff_sign_in(auth: TokenAuth, address: str, password: str) -> str:
    address = address.strip().lower()
    async with global_tx("service") as s:
        staff = await s.scalar(select(StaffUser).where(StaffUser.email == address))
        if staff is not None and staff.deactivated_at is not None:
            staff = None
        ok = await _password_ok(s, staff, password)
        token = auth.staff_token(staff) if ok and staff is not None else ""
    if not ok:
        raise Forbidden(GENERIC)
    log.info("auth.staff_sign_in", staff=address)
    return token


# ---------------------------------------------------------------------------------------------
# Passwords: reset by email link, change, sign out everywhere
# ---------------------------------------------------------------------------------------------


Account = LoginIdentity | StaffUser


async def _by_email(s: Any, kind: str, address: str) -> Account | None:
    if kind == "staff":
        staff: StaffUser | None = await s.scalar(
            select(StaffUser).where(StaffUser.email == address)
        )
        return staff
    identity: LoginIdentity | None = await s.scalar(
        select(LoginIdentity).where(LoginIdentity.email == address)
    )
    return identity


async def _account(s: Any, kind: str, subject_id: uuid.UUID) -> Account | None:
    if kind == "staff":
        staff: StaffUser | None = await s.get(StaffUser, subject_id)
        return staff
    found: LoginIdentity | None = await s.scalar(
        select(LoginIdentity).where(LoginIdentity.id == subject_id)
    )
    return found


async def request_reset(kind: str, address: str) -> dict[str, Any]:
    """Always answers the same, whether or not the email exists."""
    address = address.strip().lower()
    token = secrets.token_urlsafe(32)
    sent_to = None
    async with global_tx("service") as s:
        rules = await _rules(s)
        account = await _by_email(s, kind, address)
        if account is not None and not getattr(account, "deactivated_at", None):
            s.add(
                PasswordReset(
                    kind=kind,
                    subject_id=account.id,
                    token_hash=_hash_token(token),
                    expires_at=datetime.now(UTC)
                    + timedelta(minutes=rules.password_reset_valid_minutes),
                )
            )
            sent_to = address
    out: dict[str, Any] = {"status": "sent"}
    if sent_to:
        link = f"{get_settings().app_base_url}/reset/{token}" + (
            "?side=internal" if kind == "staff" else ""
        )
        text = (
            "Someone asked to reset your Formada password. If it was you, open this link "
            f"(valid {rules.password_reset_valid_minutes} minutes):\n{link}\n\n"
            "If it was not you, ignore this email; your password is unchanged."
        )
        html = (
            f'<p>{text.splitlines()[0]}</p><p><a href="{link}">{link}</a></p>'
            "<p>If it was not you, ignore this email.</p>"
        )
        await email.send(email.Mail(sent_to, "Reset your Formada password", text, html))
        if get_settings().env == "local":
            out["link"] = link  # dev convenience only
    return out


async def send_welcome(address: str, name: str, workspace: str, locale: str) -> dict[str, Any]:
    """The workspace owner's first sign-in: a one-time link to set their own password, valid as
    long as an invite. Never a password in the email (ADR 0027)."""
    address = address.strip().lower()
    token = secrets.token_urlsafe(32)
    async with global_tx("service") as s:
        rules = await _rules(s)
        account = await _by_email(s, "person", address)
        if account is None:
            raise NotFound("login")
        s.add(
            PasswordReset(
                kind="person",
                subject_id=account.id,
                token_hash=_hash_token(token),
                expires_at=datetime.now(UTC) + timedelta(days=rules.invite_valid_days),
            )
        )
    link = f"{get_settings().app_base_url}/reset/{token}"
    days = rules.invite_valid_days
    if locale == "fr":
        subject = f"Bienvenue sur Formada : {workspace}"
        lines = [
            f"Bonjour {name},",
            f"Votre espace {workspace} est prêt à être configuré avec notre équipe.",
            f"Choisissez votre mot de passe avec ce lien (valide {days} jours) :",
            link,
            f"Ensuite, connectez-vous avec {address} pour suivre l'intégration.",
        ]
    else:
        subject = f"Welcome to Formada: {workspace}"
        lines = [
            f"Hello {name},",
            f"Your {workspace} workspace is ready to set up with our team.",
            f"Choose your password with this link (valid {days} days):",
            link,
            f"Then sign in with {address} to follow your onboarding.",
        ]
    html = "".join(
        f'<p><a href="{link}">{link}</a></p>' if ln == link else f"<p>{ln}</p>" for ln in lines
    )
    await email.send(email.Mail(address, subject, "\n\n".join(lines) + "\n", html))
    out: dict[str, Any] = {"status": "sent", "to": address}
    if get_settings().env == "local":
        out["link"] = link  # dev convenience only
    return out


async def reset_password(token: str, password: str) -> dict[str, Any]:
    async with global_tx("service") as s:
        rules = await _rules(s)
        reset = await s.scalar(
            select(PasswordReset).where(PasswordReset.token_hash == _hash_token(token))
        )
        now = datetime.now(UTC)
        if reset is None or reset.used_at is not None or reset.expires_at < now:
            raise NotFound("reset link")
        account = await _account(s, reset.kind, reset.subject_id)
        if account is None:
            raise NotFound("reset link")
        if error := rules_auth.check_password(password, account.email, rules):
            raise Invalid(error)
        account.password_hash = hash_password(password)
        account.token_version += 1  # every existing session ends
        account.failed_attempts, account.locked_until = 0, None
        reset.used_at = now
        kind = reset.kind
    log.info("auth.password_reset", kind=kind)
    return {"status": "ok", "kind": kind}


async def change_password(
    auth: TokenAuth, kind: str, subject_email: str, current: str, new: str
) -> str:
    """Returns a fresh token: the other sessions end, this one continues."""
    error: Exception | None = None
    token = ""
    async with global_tx("service") as s:
        account = await _by_email(s, kind, subject_email.lower())
        if not await _password_ok(s, account, current) or account is None:
            error = Forbidden("the current password is wrong")
        elif problem := rules_auth.check_password(new, account.email, await _rules(s)):
            error = Invalid(problem)
        else:
            account.password_hash = hash_password(new)
            account.token_version += 1
            token = (
                auth.staff_token(account)
                if isinstance(account, StaffUser)
                else auth.person_token(account)
            )
    if error:
        raise error
    return token


async def sign_out_everywhere(kind: str, subject_email: str) -> dict[str, Any]:
    async with global_tx("service") as s:
        account = await _by_email(s, kind, subject_email.lower())
        if account is not None:
            account.token_version += 1
    return {"status": "ok"}


async def set_invite_password(person_id: uuid.UUID, address: str, password: str) -> None:
    """Called when an invite is accepted: the identity exists, it gets its first password."""
    async with global_tx("service") as s:
        identity = await s.scalar(select(LoginIdentity).where(LoginIdentity.person_id == person_id))
        if identity is None:
            raise NotFound("login identity")
        identity.password_hash = hash_password(password)
        identity.token_version += 1


async def password_problem(address: str, password: str) -> str | None:
    async with global_tx("service") as s:
        return rules_auth.check_password(password, address, await _rules(s))


# ---------------------------------------------------------------------------------------------
# Internal staff accounts (ADR 0024)
# ---------------------------------------------------------------------------------------------


def _staff_view(u: StaffUser) -> dict[str, Any]:
    return {
        "id": str(u.id),
        "email": u.email,
        "name": u.name,
        "staff_role": u.staff_role,
        "active": u.deactivated_at is None,
        "has_password": bool(u.password_hash),
        "last_login_at": u.last_login_at.isoformat() if u.last_login_at else None,
        "created_at": u.created_at.isoformat(),
    }


async def list_staff() -> list[dict[str, Any]]:
    async with global_tx("service") as s:
        return [_staff_view(u) for u in await s.scalars(select(StaffUser).order_by(StaffUser.name))]


async def create_staff(
    actor: str, address: str, name: str, role: str, password: str
) -> dict[str, Any]:
    address = address.strip().lower()
    if role not in rules_auth.STAFF_ROLES:
        raise Invalid(f"unknown staff role {role!r}")
    async with global_tx("service") as s:
        if error := rules_auth.check_password(password, address, await _rules(s)):
            raise Invalid(error)
        if await s.scalar(select(StaffUser.id).where(StaffUser.email == address)):
            raise Conflict("a staff account with this email exists")
        user = StaffUser(
            email=address,
            name=name.strip() or address,
            staff_role=role,
            password_hash=hash_password(password),
        )
        s.add(user)
        await s.flush()
        s.add(
            ConfigChange(
                workspace_id=None,
                scope="staff",
                key=address,
                old_value=None,
                new_value={"staff_role": role},
                actor=actor,
            )
        )
        return _staff_view(user)


async def update_staff(
    actor_id: uuid.UUID, actor: str, staff_id: uuid.UUID, role: str | None, deactivate: bool | None
) -> dict[str, Any]:
    async with global_tx("service") as s:
        user = await s.get(StaffUser, staff_id)
        if user is None:
            raise NotFound("staff user")
        admins = await s.scalar(
            select(func.count()).where(
                StaffUser.staff_role == "admin", StaffUser.deactivated_at.is_(None)
            )
        )
        error = rules_auth.check_staff_change(
            str(actor_id), str(staff_id), user.staff_role, role, bool(deactivate), int(admins or 0)
        )
        if error:
            raise Invalid(error)
        old = {"staff_role": user.staff_role, "active": user.deactivated_at is None}
        if role is not None:
            user.staff_role = role
        if deactivate is not None:
            user.deactivated_at = datetime.now(UTC) if deactivate else None
            user.token_version += 1  # ends their sessions
        new = {"staff_role": user.staff_role, "active": user.deactivated_at is None}
        s.add(
            ConfigChange(
                workspace_id=None,
                scope="staff",
                key=user.email,
                old_value=old,
                new_value=new,
                actor=actor,
            )
        )
        return _staff_view(user)
