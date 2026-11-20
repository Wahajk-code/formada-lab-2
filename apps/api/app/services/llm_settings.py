"""The workspace's LLM provider and model (ADR 0018): read by the pipeline, changed by the
internal team in the console (ADR 0020)."""

import uuid
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import global_tx, tenant_tx
from app.core.settings import get_settings
from app.domain.llm import PROVIDERS, validate_choice
from app.integrations.llm import KEY_ENV, is_configured
from app.models import AuditLog, ConfigChange, LlmSetting


@dataclass(frozen=True)
class Choice:
    provider: str
    model: str
    source: str  # "tenant" (picked in Settings) or "default" (LLM_BACKEND in the environment)


def default_choice() -> Choice:
    s = get_settings()
    models = {"openai": s.openai_model, "anthropic": s.anthropic_model, "gemini": s.gemini_model}
    provider = s.llm_backend
    return Choice(provider, models.get(provider, PROVIDERS[provider].default_model), "default")


async def effective_choice(session: AsyncSession) -> Choice:
    row = await session.scalar(select(LlmSetting))
    if row is None or validate_choice(row.provider, row.model):
        return default_choice()
    return Choice(row.provider, row.model, "tenant")


def _view(choice: Choice, updated_at: datetime | None) -> dict[str, Any]:
    return {
        "provider": choice.provider,
        "model": choice.model,
        "source": choice.source,
        "updated_at": updated_at.isoformat() if updated_at else None,
        "default": {"provider": default_choice().provider, "model": default_choice().model},
        "providers": [
            {
                "key": p.key,
                "label": p.label,
                "default_model": p.default_model,
                "configured": is_configured(p.key),
                "key_env": KEY_ENV.get(p.key),
                "models": [{"id": m.id, "label": m.label, "note": m.note} for m in p.models],
            }
            for p in PROVIDERS.values()
        ],
    }


async def workspace_view(tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        row = await s.scalar(select(LlmSetting))
        choice = await effective_choice(s)
    return _view(choice, row.updated_at if row and choice.source == "tenant" else None)


async def update(actor: str, tenant_id: uuid.UUID, provider: str, model: str) -> dict[str, Any]:
    """Internal team only (console, ADR 0020): the AI model is a cost and quality decision.
    Raises ValueError for an invalid choice."""
    model = model.strip()
    if error := validate_choice(provider, model):
        raise ValueError(error)
    now = datetime.now(UTC)
    async with tenant_tx("service", tenant_id) as s:
        row = await s.scalar(select(LlmSetting))
        before = {"provider": row.provider, "model": row.model} if row else None
        if row is None:
            row = LlmSetting(tenant_id=tenant_id, provider=provider, model=model)
            s.add(row)
        row.provider, row.model = provider, model
        row.updated_by, row.updated_at = None, now
        after = {"provider": provider, "model": model}
        s.add(
            AuditLog(
                tenant_id=tenant_id,
                actor=actor,
                action="llm_setting.update",
                object_type="llm_setting",
                object_id=None,
                detail={"before": before, "after": after},
            )
        )
    async with global_tx("service") as s:
        s.add(ConfigChange(workspace_id=tenant_id, scope="llm", key="llm_setting",
                           old_value=before, new_value=after, actor=actor))  # fmt: skip
    return _view(Choice(provider, model, "tenant"), now)
