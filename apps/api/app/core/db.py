"""Database engines per Postgres role, and tenant-scoped transactions.

Every query runs inside a transaction that first sets app.tenant_id (and app.person_id for user
sessions) with set_config(..., is_local => true), the bindable form of SET LOCAL. RLS reads them.
"""

import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from functools import lru_cache
from typing import Literal

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.settings import get_settings

DbRole = Literal["user", "service", "owner"]


@lru_cache
def get_engine(role: DbRole) -> AsyncEngine:
    settings = get_settings()
    url = {
        "user": settings.database_url,
        "service": settings.database_service_url,
        "owner": settings.database_owner_url,
    }[role]
    return create_async_engine(url, pool_pre_ping=True, pool_size=5, max_overflow=5)


@lru_cache
def _sessionmaker(role: DbRole) -> async_sessionmaker[AsyncSession]:
    return async_sessionmaker(get_engine(role), expire_on_commit=False)


async def set_context(
    session: AsyncSession, tenant_id: uuid.UUID, person_id: uuid.UUID | None = None
) -> None:
    await session.execute(select(func.set_config("app.tenant_id", str(tenant_id), True)))
    await session.execute(
        select(func.set_config("app.person_id", str(person_id) if person_id else "", True))
    )


@asynccontextmanager
async def tenant_tx(
    role: DbRole, tenant_id: uuid.UUID, person_id: uuid.UUID | None = None
) -> AsyncIterator[AsyncSession]:
    """One transaction with the RLS context set. Commits on success, rolls back on error."""
    async with _sessionmaker(role)() as session, session.begin():
        await set_context(session, tenant_id, person_id)
        yield session


@asynccontextmanager
async def global_tx(role: DbRole) -> AsyncIterator[AsyncSession]:
    """Transaction without tenant context: only global tables (catalog, login_identity) show."""
    async with _sessionmaker(role)() as session, session.begin():
        yield session
