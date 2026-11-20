"""The card schema the LLM must return (spec: LLM contract), plus decision_used (ADR 0013)."""

from pydantic import BaseModel


class CardDraft(BaseModel):
    signal_id: str
    title: str
    what: str
    so_what: str
    now_what: str
    decision_used: str
    expected_impact: float
    impact_unit: str
    confidence: float
    suggested_window_days: int
    suggested_metric_key: str


class CardBatch(BaseModel):
    cards: list[CardDraft]


class TranslationOut(BaseModel):
    """Translator agent output (ADR 0022)."""

    title: str
    what: str
    so_what: str
    now_what: str


class RuleDraftOut(BaseModel):
    """Rule drafter agent output (ADR 0022)."""

    text: str
