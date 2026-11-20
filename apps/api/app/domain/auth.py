"""In-app authentication rules (ADR 0023) and internal staff permissions (ADR 0024). Pure.

Passwords are hashed in core/passwords.py; this module only decides: is a password acceptable,
is an account locked, what does a failed attempt do, and what may a staff role do.
"""

from dataclasses import dataclass
from datetime import datetime, timedelta

from app.domain.config import RulesConfig


def check_password(password: str, email: str, rules: RulesConfig) -> str | None:
    """Error message, or None when the password is acceptable."""
    if len(password) < rules.password_min_length:
        return f"use at least {rules.password_min_length} characters"
    if len(password) > 200:
        return "use at most 200 characters"
    if len(set(password)) < 4:
        return "use more than 3 different characters"
    local = email.split("@", 1)[0].lower()
    if len(local) >= 4 and local in password.lower():
        return "do not include your email address"
    return None


def is_locked(locked_until: datetime | None, now: datetime) -> bool:
    return locked_until is not None and locked_until > now


@dataclass(frozen=True)
class Attempt:
    failed_attempts: int
    locked_until: datetime | None


def after_failure(failed_attempts: int, now: datetime, rules: RulesConfig) -> Attempt:
    """A wrong password: count it; at the limit, lock for a while and start counting again."""
    count = failed_attempts + 1
    if count >= rules.login_max_attempts:
        return Attempt(0, now + timedelta(minutes=rules.login_lockout_minutes))
    return Attempt(count, None)


# ---------------------------------------------------------------------------------------------
# Internal staff permissions (ADR 0024)
# ---------------------------------------------------------------------------------------------

STAFF_ROLES = ("admin", "developer")

# admin: everything. developer: read everything, build and test (draft prompts, evaluations,
# config previews), but never change what clients see or pay for.
PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": frozenset(
        {
            "view",
            "config.preview",
            "config.write",
            "llm.write",
            "agent.draft",
            "agent.evaluate",
            "agent.activate",
            "rules.review",
            "runs.trigger",
            "staff.manage",
        }
    ),
    "developer": frozenset({"view", "config.preview", "agent.draft", "agent.evaluate"}),
}


def staff_can(role: str, action: str) -> bool:
    return action in PERMISSIONS.get(role, frozenset())


def check_staff_change(
    actor_id: str,
    target_id: str,
    target_role: str,
    new_role: str | None,
    deactivate: bool,
    active_admins: int,
) -> str | None:
    """Keep at least one active admin; nobody demotes or deactivates themselves."""
    if new_role is not None and new_role not in STAFF_ROLES:
        return f"unknown staff role {new_role!r}"
    if actor_id == target_id and (deactivate or new_role not in (None, target_role)):
        return "you cannot change your own role or deactivate yourself"
    loses_admin = target_role == "admin" and (deactivate or new_role == "developer")
    if loses_admin and active_admins <= 1:
        return "the console needs at least one active admin"
    return None
