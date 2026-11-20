import uuid
from datetime import datetime
from decimal import Decimal
from typing import Any

from pydantic import BaseModel, ConfigDict


class CardOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    role_node_id: uuid.UUID
    status: str
    title: str
    what: str
    so_what: str
    now_what: str
    decision_used: str | None
    evidence: dict[str, Any]
    expected_impact: Decimal
    impact_unit: str
    confidence: Decimal
    priority: int
    language: str
    suggested_window_days: int | None
    suggested_metric_key: str | None
    fingerprint: str
    generated_by: str | None
    run_id: uuid.UUID | None
    expires_at: datetime
    closed_at: datetime | None
    created_at: datetime


class RoleCardsOut(BaseModel):
    role_node_id: uuid.UUID
    cards: list[CardOut]
    rollup: list[CardOut]
