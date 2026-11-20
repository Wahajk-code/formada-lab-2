"""Workspace access rules for client people (ADR 0021). Pure.

  owner   everything an admin can do, plus making or removing owners; at least one must remain
  admin   invite people, change member/admin roles, assign people to role nodes, workspace settings,
          rule review
  member  sees and acts on cards through their role-node assignments only

Role-node assignments keep their own permission: owner (can act on the role's cards) or viewer.
"""

import re

WORKSPACE_ROLES = ("owner", "admin", "member")
NODE_PERMISSIONS = ("owner", "viewer")
_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


def is_admin(app_role: str) -> bool:
    return app_role in ("owner", "admin")


def check_invite(actor_role: str, email: str, role: str) -> str | None:
    if not is_admin(actor_role):
        return "only owners and admins can invite people"
    if not _EMAIL.match(email.strip()):
        return "invalid email address"
    if role not in WORKSPACE_ROLES:
        return f"unknown workspace role {role!r}"
    if role == "owner" and actor_role != "owner":
        return "only an owner can invite another owner"
    return None


def check_role_change(actor_role: str, current: str, new: str, owners: int) -> str | None:
    """owners = how many owners the workspace has now (including the target, if an owner)."""
    if not is_admin(actor_role):
        return "only owners and admins can change roles"
    if new not in WORKSPACE_ROLES:
        return f"unknown workspace role {new!r}"
    if "owner" in (current, new) and actor_role != "owner":
        return "only an owner can grant or remove the owner role"
    if current == "owner" and new != "owner" and owners <= 1:
        return "a workspace needs at least one owner"
    return None


def check_removal(actor_role: str, target_role: str, owners: int, is_self: bool) -> str | None:
    if not is_admin(actor_role):
        return "only owners and admins can remove people"
    if is_self:
        return "you cannot remove yourself"
    if target_role == "owner" and actor_role != "owner":
        return "only an owner can remove an owner"
    if target_role == "owner" and owners <= 1:
        return "a workspace needs at least one owner"
    return None


def check_assignments(assignments: list[tuple[str, str]], known_roles: set[str]) -> str | None:
    """(role_node_id, permission) pairs for one person."""
    seen = set()
    for role_id, permission in assignments:
        if role_id not in known_roles:
            return f"unknown role node {role_id}"
        if permission not in NODE_PERMISSIONS:
            return f"unknown permission {permission!r}"
        if role_id in seen:
            return "a role node is listed twice"
        seen.add(role_id)
    return None
