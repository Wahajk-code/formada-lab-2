"""What each onboarding agent must return (ADR 0026). Structured output: lists of objects and
enums only (no free-form dicts), so every provider can enforce the schema."""

from typing import Literal

from pydantic import BaseModel

Confidence = Literal["high", "medium", "low"]


# ---- discovery_analyst ----------------------------------------------------------------------


class JoinGuess(BaseModel):
    column: str
    references_table: str
    references_column: str
    confidence: Confidence


class TableGuide(BaseModel):
    table: str  # SCHEMA.TABLE as in the profile
    kind: Literal["fact", "dimension", "lookup", "other"]
    grain: str
    purpose: str
    key_columns: list[str]
    joins: list[JoinGuess]


class Coverage(BaseModel):
    family: Literal[
        "inventory",
        "sales",
        "returns",
        "purchase_orders",
        "receipts",
        "transfers",
        "vendors",
        "customers",
        "calendar",
    ]
    status: Literal["present", "partial", "missing"]
    evidence: str


class QualityIssue(BaseModel):
    title: str
    severity: Literal["high", "medium", "low"]
    evidence: str
    impact: str
    suggested_handling: str
    columns: list[str]  # TABLE.COLUMN involved


class ClientQuestion(BaseModel):
    to: Literal["client", "team"]
    question: str
    why: str


class SemanticGuide(BaseModel):
    """One semantic view the customer already keeps: what it models and how to use it."""

    view: str  # SCHEMA.VIEW as in the profile
    purpose: str
    grain: str  # what one row of its main fact table is
    families: list[str]  # standard data families it can feed (sales, inventory, ...)
    key_metrics: list[str]  # TABLE.METRIC names the profile lists
    key_dimensions: list[str]  # TABLE.DIMENSION names the profile lists
    use_for: Literal["map_from_view", "map_from_tables", "reference_only"]
    caveats: list[str]  # what the view cannot answer (a table not linked, a missing field)


class DiscoveryOut(BaseModel):
    summary: str
    tables: list[TableGuide]
    semantic_views: list[SemanticGuide]
    cadence: str
    coverage: list[Coverage]
    quality_issues: list[QualityIssue]
    questions: list[ClientQuestion]


# ---- data_mapper ----------------------------------------------------------------------------


class FieldMatch(BaseModel):
    field: str
    source_columns: list[str]  # TABLE.COLUMN used, empty when NULL
    expression: str  # in plain words
    confidence: Confidence
    reason: str


class ArchetypeProposal(BaseModel):
    archetype: str
    status: Literal["mapped", "partial", "unmappable"]
    source_sql: str
    fields: list[FieldMatch]
    filters: list[str]
    questions: list[str]


class MappingOut(BaseModel):
    archetypes: list[ArchetypeProposal]


# ---- org_designer ---------------------------------------------------------------------------


class DepartmentDraft(BaseModel):
    name: str
    playbook: str
    head_ref: str


class RoleDraft(BaseModel):
    ref: str
    title: str
    archetype: str
    department: str  # empty for the CEO
    parent_ref: str  # empty only for the root
    why: str


class OrgOut(BaseModel):
    departments: list[DepartmentDraft]
    roles: list[RoleDraft]
    notes: list[str]


# ---- metric_advisor -------------------------------------------------------------------------


class ParamValue(BaseModel):
    name: str
    value: int


class ThresholdRule(BaseModel):
    kind: Literal["none", "percentile", "median_multiple"]
    value: float  # percentile 50-99, or a multiple of the median; 0 for none
    basis: str


class Attachment(BaseModel):
    role_ref: str
    weight: float
    threshold: ThresholdRule
    daily_check: bool
    why: str


class MetricDraft(BaseModel):
    key: str
    name: str
    template: str
    template_version: int
    unit: str
    higher_is_better: bool
    unit_value: float
    unit_value_basis: str
    params: list[ParamValue]
    attach: list[Attachment]


class SkippedTemplate(BaseModel):
    template: str
    reason: str


class MetricsOut(BaseModel):
    metrics: list[MetricDraft]
    skipped: list[SkippedTemplate]


# ---- rules_advisor --------------------------------------------------------------------------


class RuleChange(BaseModel):
    key: str
    value: float
    reason: str


class RuleKept(BaseModel):
    key: str
    why: str


class RulesOut(BaseModel):
    changes: list[RuleChange]
    kept: list[RuleKept]
    risks: list[str]
