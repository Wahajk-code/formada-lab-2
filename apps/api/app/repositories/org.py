import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.domain.config import RulesConfig, layered
from app.domain.org import Node
from app.models import Department, Person, RoleAssignment, RoleNode, SystemConfig
from app.models import RulesConfig as RulesConfigRow


async def nodes(session: AsyncSession) -> dict[uuid.UUID, Node]:
    rows = await session.execute(select(RoleNode.id, RoleNode.parent_role_id, RoleNode.holder_type))
    return {r.id: Node(r.id, r.parent_role_id, r.holder_type == "vacant") for r in rows}


async def visible_role_ids(session: AsyncSession) -> set[uuid.UUID]:
    """Visibility for the person in the current RLS context (app.person_id)."""
    rows = await session.scalars(select(func.visible_role_ids(func.app_person_id())))
    return set(rows)


async def system_overrides(session: AsyncSession) -> dict[str, Any]:
    rows = await session.execute(select(SystemConfig.key, SystemConfig.value))
    return {r.key: r.value for r in rows}


async def workspace_overrides(session: AsyncSession) -> dict[str, Any]:
    rows = await session.execute(select(RulesConfigRow.key, RulesConfigRow.value))
    return {r.key: r.value for r in rows}


async def rules(session: AsyncSession) -> RulesConfig:
    """Effective numbers for the session's workspace: default -> system -> workspace (ADR 0020)."""
    return layered(await system_overrides(session), await workspace_overrides(session))


async def org_web(session: AsyncSession) -> dict[str, Any]:
    departments = (await session.scalars(select(Department).order_by(Department.sort_order))).all()
    roles = (await session.scalars(select(RoleNode))).all()
    holders = await session.execute(
        select(RoleAssignment.role_node_id, Person.id, Person.name)
        .join(Person, Person.id == RoleAssignment.person_id)
        .where(
            RoleAssignment.grant_effect == "allow",
            RoleAssignment.permission == "owner",
            Person.deactivated_at.is_(None),
        )
    )
    by_role: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for h in holders:
        by_role.setdefault(h.role_node_id, []).append({"id": h.id, "name": h.name})
    return {"departments": departments, "roles": roles, "holders": by_role}
