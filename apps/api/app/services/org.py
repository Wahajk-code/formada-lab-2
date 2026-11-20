"""Org web and identity views for the web app. Everything runs under the caller's RLS context."""

import uuid
from typing import Any

from sqlalchemy import func, select

from app.core.auth import Principal
from app.core.db import global_tx, tenant_tx
from app.domain import org as org_rules
from app.models import (
    Department,
    LoginIdentity,
    Metric,
    Notification,
    Person,
    RoleArchetype,
    RoleAssignment,
    RoleMetric,
    RoleNode,
    RoleSummary,
    Tenant,
)
from app.repositories import org as org_repo


async def _assigned_roles(s: Any, person_id: uuid.UUID) -> list[dict[str, Any]]:
    rows = await s.execute(
        select(RoleNode, Department.name, RoleAssignment.permission)
        .join(RoleAssignment, RoleAssignment.role_node_id == RoleNode.id)
        .outerjoin(Department, Department.id == RoleNode.department_id)
        .where(RoleAssignment.person_id == person_id, RoleAssignment.grant_effect == "allow")
        .order_by(RoleNode.title)
    )
    return [
        {"id": str(r.id), "title": r.title, "department": dept, "permission": perm}
        for r, dept, perm in rows.all()
    ]


async def dev_users() -> list[dict[str, Any]]:
    """Seeded users for the dev login picker, resolved inside each user's own RLS context."""
    async with global_tx("service") as s:  # login_identity is service-only (ADR 0023)
        identities = (await s.scalars(select(LoginIdentity))).all()
    users = []
    for i in identities:
        async with tenant_tx("user", i.tenant_id, i.person_id) as s:
            person = await s.get(Person, i.person_id)
            tenant = await s.get(Tenant, i.tenant_id)
            if person is None or tenant is None:
                continue
            users.append(
                {
                    "email": i.email,
                    "name": person.name,
                    "tenant": tenant.name,
                    "app_role": person.app_role,
                    "roles": [r["title"] for r in await _assigned_roles(s, person.id)],
                }
            )
    return sorted(users, key=lambda u: (u["tenant"], u["roles"] == [], u["name"]))


async def me(principal: Principal) -> dict[str, Any]:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        tenant = await s.get(Tenant, principal.tenant_id)
        roles = await _assigned_roles(s, principal.person_id)
        unread = await s.scalar(
            select(func.count()).select_from(Notification).where(Notification.read_at.is_(None))
        )
    return {
        "person_id": str(principal.person_id),
        "name": principal.name,
        "email": principal.email,
        "app_role": principal.app_role,
        "locale": principal.locale,
        "tenant": {
            "id": str(principal.tenant_id),
            "name": tenant.name if tenant else "",
            "lifecycle": tenant.lifecycle if tenant else "live",
        },
        "roles": roles,
        "unread_notifications": unread,
    }


async def org_web(principal: Principal) -> dict[str, Any]:
    """Visible departments and role nodes, holders, roll-up counts and card owner per node."""
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        return await org_payload(s, await org_repo.visible_role_ids(s))


async def org_payload(s: Any, visible: set[uuid.UUID]) -> dict[str, Any]:
    """The org web limited to `visible` (the console passes every node)."""
    web = await org_repo.org_web(s)
    nodes = await org_repo.nodes(s)
    summaries = {r.role_node_id: r for r in await s.scalars(select(RoleSummary))}
    metric_rows = await s.execute(
        select(RoleMetric, Metric.name, Metric.key, Metric.unit)
        .join(Metric, Metric.id == RoleMetric.metric_id)
        .order_by(Metric.name)
    )
    metrics: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for rm, name, key, unit in metric_rows:
        metrics.setdefault(rm.role_node_id, []).append(
            {
                "key": key,
                "name": name,
                "unit": unit,
                "weight": float(rm.weight),
                "threshold": float(rm.threshold) if rm.threshold is not None else None,
                "daily_check": rm.daily_check,
            }
        )
    levels = {a.key: a.definition.get("level") for a in await s.scalars(select(RoleArchetype))}
    roles = []
    for r in web["roles"]:
        if r.id not in visible:
            continue
        summary = summaries.get(r.id)
        owner = org_rules.nearest_filled_ancestor(nodes, r.id)
        roles.append(
            {
                "id": str(r.id),
                "title": r.title,
                "level": levels.get(r.role_archetype_key or ""),
                "department_id": str(r.department_id) if r.department_id else None,
                "parent_id": str(r.parent_role_id) if r.parent_role_id else None,
                "holder_type": r.holder_type,
                "holders": [h["name"] for h in web["holders"].get(r.id, [])],
                "cards_route_to": str(owner) if owner and owner != r.id else None,
                "open_cards": summary.open_cards if summary else 0,
                "open_cards_subtree": summary.open_cards_subtree if summary else 0,
                "value_captured_subtree": float(summary.value_captured_subtree) if summary else 0,
                "cadence": r.cadence,
                "language": r.language,
                "decisions_owned": list(r.decisions_owned or []),
                "decisions_forbidden": list(r.decisions_forbidden or []),
                "kpi_notes": r.kpi_notes,
                "metrics": metrics.get(r.id, []),
            }
        )
    visible_departments = {r["department_id"] for r in roles}
    departments = [
        {
            "id": str(d.id),
            "name": d.name,
            "head_role_id": str(d.head_role_id) if d.head_role_id else None,
        }
        for d in web["departments"]
        if str(d.id) in visible_departments
    ]
    return {"departments": departments, "roles": roles}


async def lifecycle(principal: Principal) -> str:
    async with tenant_tx("user", principal.tenant_id, principal.person_id) as s:
        tenant = await s.get(Tenant, principal.tenant_id)
    return tenant.lifecycle if tenant else "live"
