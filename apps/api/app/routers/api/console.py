"""/api/console/*: the internal team console (ADR 0020). Staff tokens only; a workspace user's
token is refused. Reads and writes go through services.console, one workspace at a time."""

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.auth import CurrentStaff, StaffPrincipal, TokenAuth, get_auth
from app.domain.auth import PERMISSIONS, staff_can
from app.integrations import n8n
from app.services import (
    agents,
    ai_lab,
    assistant,
    console,
    console_ai,
    custom_metrics,
    llm_settings,
    onboarding,
    onboarding_collab,
    onboarding_items,
    onboarding_review,
)
from app.services import auth as auth_service
from app.services import feedback as feedback_service

router = APIRouter(prefix="/console", tags=["console"])


def _require(action: str) -> Any:
    """A dependency that lets a staff member through only if their role may do `action`."""

    async def check(staff: CurrentStaff) -> StaffPrincipal:
        if not staff_can(staff.staff_role, action):
            raise HTTPException(status.HTTP_403_FORBIDDEN, f"{staff.staff_role} cannot {action}")
        return staff

    return check


ConfigWriter = Annotated[StaffPrincipal, Depends(_require("config.write"))]
LlmWriter = Annotated[StaffPrincipal, Depends(_require("llm.write"))]
Reviewer = Annotated[StaffPrincipal, Depends(_require("rules.review"))]
Trigger = Annotated[StaffPrincipal, Depends(_require("runs.trigger"))]
Drafter = Annotated[StaffPrincipal, Depends(_require("agent.draft"))]
Activator = Annotated[StaffPrincipal, Depends(_require("agent.activate"))]
Evaluator = Annotated[StaffPrincipal, Depends(_require("agent.evaluate"))]
StaffManager = Annotated[StaffPrincipal, Depends(_require("staff.manage"))]


class ValueIn(BaseModel):
    value: Any


class RoleMetricIn(BaseModel):
    weight: float | None = None
    threshold: float | None = None
    clear_threshold: bool = False
    daily_check: bool | None = None


class MetricIn(BaseModel):
    unit_value: float | None = None
    is_active: bool | None = None


class PreviewIn(BaseModel):
    overrides: dict[str, Any] = {}
    role_metrics: dict[str, dict[str, Any]] = {}


class LlmIn(BaseModel):
    provider: str
    model: str


class ReviewIn(BaseModel):
    action: Literal["accept", "reject", "retire"]
    text: str | None = Field(default=None, max_length=500)


class VersionIn(BaseModel):
    body: str = Field(max_length=20000)
    notes: str = Field(default="", max_length=1000)


class AgentIn(BaseModel):
    active_version: int | None = None
    model_override: str | None = None
    use_examples: bool | None = None


class EvaluateIn(BaseModel):
    version: int
    workspace_id: uuid.UUID
    samples: int = Field(default=3, ge=1, le=5)


@router.get("/me")
async def me(staff: CurrentStaff) -> dict[str, Any]:
    return {
        "email": staff.email,
        "name": staff.name,
        "staff_role": staff.staff_role,
        "permissions": sorted(PERMISSIONS.get(staff.staff_role, frozenset())),
    }


@router.get("/overview")
async def overview(staff: CurrentStaff) -> dict[str, Any]:
    return await console.overview()


@router.get("/workspaces/{tenant_id}")
async def workspace(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    return await console.workspace(tenant_id)


@router.get("/workspaces/{tenant_id}/runs/{run_id}")
async def run_detail(
    tenant_id: uuid.UUID, run_id: uuid.UUID, staff: CurrentStaff
) -> dict[str, Any]:
    return await console.run_detail(tenant_id, run_id)


@router.post("/workspaces/{tenant_id}/run")
async def run_now(tenant_id: uuid.UUID, staff: Trigger) -> dict[str, Any]:
    if not await n8n.run_now(tenant_id):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "n8n is not reachable")
    return {"status": "started"}


# ---- config ---------------------------------------------------------------------------------


@router.get("/config")
async def system_config(staff: CurrentStaff) -> dict[str, Any]:
    return await console.system_config()


@router.put("/config/{key}")
async def set_system(key: str, body: ValueIn, staff: ConfigWriter) -> dict[str, Any]:
    return await console.set_system(staff.actor, key, body.value)


@router.delete("/config/{key}")
async def reset_system(key: str, staff: ConfigWriter) -> dict[str, Any]:
    return await console.reset_system(staff.actor, key)


@router.get("/workspaces/{tenant_id}/config")
async def workspace_config(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    return await console.workspace_config(tenant_id)


@router.put("/workspaces/{tenant_id}/config/{key}")
async def set_workspace(
    tenant_id: uuid.UUID, key: str, body: ValueIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await console.set_workspace(staff.actor, tenant_id, key, body.value)


@router.delete("/workspaces/{tenant_id}/config/{key}")
async def reset_workspace(tenant_id: uuid.UUID, key: str, staff: ConfigWriter) -> dict[str, Any]:
    return await console.reset_workspace(staff.actor, tenant_id, key)


@router.patch("/workspaces/{tenant_id}/role-metrics/{role_metric_id}")
async def set_role_metric(
    tenant_id: uuid.UUID, role_metric_id: uuid.UUID, body: RoleMetricIn, staff: ConfigWriter
) -> dict[str, Any]:
    changes: dict[str, Any] = body.model_dump(exclude_none=True, exclude={"clear_threshold"})
    if body.clear_threshold:
        changes["threshold"] = None
    return await console.set_role_metric(staff.actor, tenant_id, role_metric_id, changes)


@router.patch("/workspaces/{tenant_id}/metrics/{metric_id}")
async def set_metric(
    tenant_id: uuid.UUID, metric_id: uuid.UUID, body: MetricIn, staff: ConfigWriter
) -> dict[str, Any]:
    changes = body.model_dump(exclude_none=True)
    return await console.set_metric(staff.actor, tenant_id, metric_id, changes)


@router.post("/workspaces/{tenant_id}/preview")
async def preview(tenant_id: uuid.UUID, body: PreviewIn, staff: CurrentStaff) -> dict[str, Any]:
    return await console.preview(tenant_id, body.overrides, body.role_metrics)


@router.get("/history")
async def history(
    staff: CurrentStaff, workspace_id: Annotated[uuid.UUID | None, Query()] = None
) -> list[dict[str, Any]]:
    return await console.history(workspace_id)


@router.get("/workspaces/{tenant_id}/llm")
async def get_llm(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    return await llm_settings.workspace_view(tenant_id)


@router.put("/workspaces/{tenant_id}/llm")
async def put_llm(tenant_id: uuid.UUID, body: LlmIn, staff: LlmWriter) -> dict[str, Any]:
    try:
        return await llm_settings.update(staff.actor, tenant_id, body.provider, body.model)
    except ValueError as exc:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(exc)) from exc


# ---- rules ----------------------------------------------------------------------------------


@router.get("/rules")
async def rules(
    staff: CurrentStaff, status_filter: Annotated[str | None, Query(alias="status")] = None
) -> list[dict[str, Any]]:
    return await console.all_rules(status_filter)


@router.patch("/workspaces/{tenant_id}/rules/{rule_id}")
async def review_rule(
    tenant_id: uuid.UUID, rule_id: uuid.UUID, body: ReviewIn, staff: Reviewer
) -> dict[str, Any]:
    return await feedback_service.review_rule_as_staff(
        staff.actor, tenant_id, rule_id, body.action, body.text
    )


# ---- agents ---------------------------------------------------------------------------------


@router.get("/agents")
async def agent_registry(staff: CurrentStaff) -> dict[str, Any]:
    return await agents.registry()


@router.get("/agents/{key}")
async def agent_detail(key: str, staff: CurrentStaff) -> dict[str, Any]:
    return await agents.detail(key)


@router.post("/agents/{key}/versions")
async def new_version(key: str, body: VersionIn, staff: Drafter) -> dict[str, Any]:
    return await agents.create_version(staff.actor, key, body.body, body.notes)


@router.patch("/agents/{key}")
async def update_agent(key: str, body: AgentIn, staff: Activator) -> dict[str, Any]:
    return await agents.update_agent(staff.actor, key, body.model_dump(exclude_unset=True))


@router.post("/agents/{key}/evaluate")
async def evaluate(key: str, body: EvaluateIn, staff: Evaluator) -> dict[str, Any]:
    return await agents.evaluate(key, body.version, body.workspace_id, body.samples)


# ---- AI lab (dev mode): the process of each onboarding agent, editable and testable ----------


class LabTestIn(BaseModel):
    version: int | None = None
    prompt: str | None = Field(default=None, max_length=60000)
    notes: str = Field(default="", max_length=4000)
    input: dict[str, Any] | None = None
    model: str | None = Field(default=None, max_length=120)
    effort: str = "medium"


@router.get("/ai-lab")
async def lab_overview(
    staff: CurrentStaff, workspace_id: Annotated[uuid.UUID | None, Query()] = None
) -> dict[str, Any]:
    return await ai_lab.overview(workspace_id)


@router.get("/workspaces/{tenant_id}/ai-lab/{step}")
async def lab_runs(tenant_id: uuid.UUID, step: str, staff: CurrentStaff) -> dict[str, Any]:
    return await ai_lab.runs(tenant_id, step)


@router.post("/workspaces/{tenant_id}/ai-lab/{step}/test")
async def lab_test(
    tenant_id: uuid.UUID, step: str, body: LabTestIn, staff: Evaluator
) -> dict[str, Any]:
    return await ai_lab.test(staff.actor, tenant_id, step, body.model_dump())


# ---- feedback insights (ADR 0025) -----------------------------------------------------------


@router.get("/workspaces/{tenant_id}/feedback")
async def feedback_insights(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    return await console.feedback_insights(tenant_id)


# ---- AI onboarding (ADR 0026) ---------------------------------------------------------------


class WorkspaceIn(BaseModel):
    name: str = Field(min_length=2, max_length=200)
    owner_name: str = Field(min_length=2, max_length=200)
    owner_email: str = Field(max_length=320)
    locale: Literal["en", "fr"] = "en"
    timezone: str = Field(default="America/Toronto", max_length=64)
    currency: str = Field(default="CAD", min_length=3, max_length=3)
    llm_provider: str = "anthropic"
    llm_model: str = "claude-haiku-5-5"


class ConnectionIn(BaseModel):
    account_identifier: str = Field(max_length=200)
    user_name: str = Field(max_length=200)
    role_name: str = Field(max_length=200)
    warehouse_name: str = Field(max_length=200)
    database_name: str = Field(max_length=200)
    schemas: list[str] = []
    secret_ref: str = Field(default="", max_length=300)
    monthly_credit_cap: float = Field(default=25, ge=0, le=100000)


class NotesIn(BaseModel):
    notes: str = Field(default="", max_length=8000)


class MappingEditIn(BaseModel):
    archetypes: list[dict[str, Any]]


class ApproveIn(BaseModel):
    keys: list[str] | None = None
    # Needed when a check is still open (review by exception, ADR 0029); goes to the audit log.
    reason: str = Field(default="", max_length=500)


class ReasonIn(BaseModel):
    reason: str = Field(default="", max_length=500)


ItemStep = Literal["mapping", "org", "metrics", "rules"]


class GoalIn(BaseModel):
    goal: str = Field(default="", max_length=2000)


class MeasureIn(BaseModel):
    template: str
    name: str = ""
    unit: str = ""
    higher_is_better: bool = False
    unit_value: float = 1
    roles: list[dict[str, Any]]


class ReviseIn(BaseModel):
    instruction: str = Field(max_length=2000)


class ItemIn(BaseModel):
    item: dict[str, Any]


class PresetIn(BaseModel):
    name: Literal["fewer", "balanced", "more"]


class CheckinIn(BaseModel):
    at: datetime | None = None
    note: str = Field(default="", max_length=500)
    lead: str = Field(default="", max_length=200)


OnboardingStepName = Literal["discovery", "mapping", "org", "metrics", "rules"]


@router.post("/workspaces")
async def create_workspace(body: WorkspaceIn, staff: ConfigWriter) -> dict[str, Any]:
    return await onboarding.create_workspace(staff.actor, body.model_dump())


@router.get("/workspaces/{tenant_id}/onboarding")
async def onboarding_state(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    state = await onboarding.state(tenant_id)
    return {
        **state,
        **await onboarding_collab.team_extras(tenant_id),
        "review": await onboarding_review.review(tenant_id),
    }


# ---- AI help in the console: it suggests, a person saves (ADR 0029) ---------------------------


@router.post("/config/suggest")
async def suggest_system(body: GoalIn, staff: ConfigWriter) -> dict[str, Any]:
    return await console_ai.suggest_settings(None, body.goal)


@router.post("/workspaces/{tenant_id}/config/suggest")
async def suggest_workspace(
    tenant_id: uuid.UUID, body: GoalIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await console_ai.suggest_settings(tenant_id, body.goal)


@router.post("/agents/{key}/draft")
async def draft_agent_version(key: str, body: GoalIn, staff: CurrentStaff) -> dict[str, Any]:
    """An AI first draft of new instructions; saving and activating stay manual."""
    return await console_ai.draft_prompt(key, body.goal)


@router.post("/workspaces/{tenant_id}/metrics/suggest")
async def suggest_measures(
    tenant_id: uuid.UUID, body: GoalIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await console_ai.suggest_measures(tenant_id, body.goal)


@router.post("/workspaces/{tenant_id}/metrics")
async def add_measure(tenant_id: uuid.UUID, body: MeasureIn, staff: ConfigWriter) -> dict[str, Any]:
    return await console_ai.add_measure(staff.actor, tenant_id, body.model_dump())


@router.get("/workspaces/{tenant_id}/metrics/templates")
async def measure_templates(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    """Catalog measures this workspace's data can feed (for Add a measure)."""
    from app.services import onboarding as ob_svc

    templates, _ = await ob_svc._feedable_templates(tenant_id)
    return {"templates": [{"key": t.key, "description": t.description, "playbook": t.playbook}
                          for t in templates]}  # fmt: skip


@router.post("/workspaces/{tenant_id}/onboarding/{step}/{step_id}/items/{key}/revise")
async def onboarding_revise_item(
    tenant_id: uuid.UUID, step: ItemStep, step_id: uuid.UUID, key: str, body: ReviseIn,
    staff: ConfigWriter,
) -> dict[str, Any]:  # fmt: skip
    """Ask the AI to change one item of a proposal; everything else stays as it is."""
    return await onboarding_items.revise_item(
        staff.actor, tenant_id, step, step_id, key, body.instruction
    )


@router.put("/workspaces/{tenant_id}/onboarding/{step}/{step_id}/items/{key}")
async def onboarding_edit_item(
    tenant_id: uuid.UUID, step: ItemStep, step_id: uuid.UUID, key: str, body: ItemIn,
    staff: ConfigWriter,
) -> dict[str, Any]:  # fmt: skip
    """Edit one item by hand; it is locked so a later full analysis keeps it."""
    return await onboarding_items.edit_item(staff.actor, tenant_id, step, step_id, key, body.item)


@router.post("/workspaces/{tenant_id}/onboarding/{step}/{step_id}/items/{key}/confirm")
async def onboarding_confirm_item(
    tenant_id: uuid.UUID, step: ItemStep, step_id: uuid.UUID, key: str, staff: ConfigWriter
) -> dict[str, Any]:
    """Mark one mapping link as checked (also locks it against a re-run)."""
    return await onboarding_items.confirm_item(staff.actor, tenant_id, step, step_id, key)


DiscoverySection = Literal["guide", "relationships", "gaps"]


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/sections/{section}/revise")
async def onboarding_revise_section(
    tenant_id: uuid.UUID,
    step_id: uuid.UUID,
    section: DiscoverySection,
    body: ReviseIn,
    staff: ConfigWriter,
) -> dict[str, Any]:
    """Ask the AI to change one discovery section; the others stay as they are."""
    return await onboarding_items.revise_section(
        staff.actor, tenant_id, step_id, section, body.instruction
    )


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/sections/{section}/lock")
async def onboarding_lock_section(
    tenant_id: uuid.UUID, step_id: uuid.UUID, section: DiscoverySection, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_items.set_section_lock(staff.actor, tenant_id, step_id, section, True)


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/sections/{section}/unlock")
async def onboarding_unlock_section(
    tenant_id: uuid.UUID, step_id: uuid.UUID, section: DiscoverySection, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_items.set_section_lock(staff.actor, tenant_id, step_id, section, False)


class CardEditIn(BaseModel):
    card_id: str = Field(max_length=200)
    fields: dict[str, Any] = Field(max_length=6)


class CardLockIn(BaseModel):
    card_id: str = Field(max_length=200)
    locked: bool


class CardSuggestIn(BaseModel):
    card_ids: list[str] = Field(min_length=1, max_length=8)
    instruction: str = Field(max_length=2000)


class JoinRemoveIn(BaseModel):
    card_id: str = Field(max_length=400)


class JoinAddIn(BaseModel):
    table: str = Field(max_length=200)
    column: str = Field(max_length=200)
    references_table: str = Field(max_length=200)
    references_column: str = Field(max_length=200)


class CardApplyIn(BaseModel):
    changes: list[dict[str, Any]] = Field(max_length=40)
    note: str = Field(default="", max_length=2000)
    confirm_large: bool = False


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/cards/edit")
async def onboarding_edit_card(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: CardEditIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Change one discovery card by hand. The edit locks the card."""
    return await onboarding_items.edit_card(
        staff.actor, tenant_id, step_id, body.card_id, body.fields
    )


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/cards/lock")
async def onboarding_lock_card(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: CardLockIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_items.set_card_lock(
        staff.actor, tenant_id, step_id, body.card_id, body.locked
    )


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/cards/remove-join")
async def onboarding_remove_join(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: JoinRemoveIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Take one relationship out of the guide; a rerun does not bring it back."""
    return await onboarding_items.remove_join_card(staff.actor, tenant_id, step_id, body.card_id)


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/cards/add-join")
async def onboarding_add_join(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: JoinAddIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Declare a relationship the scan missed; it is locked so a rerun keeps it."""
    return await onboarding_items.add_join_card(
        staff.actor,
        tenant_id,
        step_id,
        body.table,
        body.column,
        body.references_table,
        body.references_column,
    )


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/cards/suggest")
async def onboarding_suggest_cards(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: CardSuggestIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Ask the AI how to change the cards the team named. Saves nothing."""
    return await onboarding_items.suggest_card_changes(
        tenant_id, step_id, body.card_ids, body.instruction
    )


@router.post("/workspaces/{tenant_id}/onboarding/discovery/{step_id}/cards/apply")
async def onboarding_apply_cards(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: CardApplyIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Apply the card changes the team approved; every rule is checked again."""
    return await onboarding_items.apply_card_changes(
        staff.actor, tenant_id, step_id, body.changes, body.note, body.confirm_large
    )


@router.post("/workspaces/{tenant_id}/onboarding/{step}/{step_id}/items/{key}/unlock")
async def onboarding_unlock_item(
    tenant_id: uuid.UUID, step: ItemStep, step_id: uuid.UUID, key: str, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_items.unlock_item(staff.actor, tenant_id, step, step_id, key)


@router.post("/workspaces/{tenant_id}/rules/preset")
async def apply_preset(tenant_id: uuid.UUID, body: PresetIn, staff: ConfigWriter) -> dict[str, Any]:
    """Apply a rules preset (Fewer, Balanced, More) as workspace overrides (ADR 0030)."""
    from app.domain.config import PRESETS

    for key, value in PRESETS[body.name].items():
        await console.set_workspace(staff.actor, tenant_id, key, value)
    return {"status": "ok", "preset": body.name, "values": PRESETS[body.name]}


@router.put("/workspaces/{tenant_id}/onboarding/checkin")
async def onboarding_checkin(
    tenant_id: uuid.UUID, body: CheckinIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Schedule (or clear, with no date) the next check-in the client sees (ADR 0030)."""
    return await onboarding_collab.set_checkin(
        staff.actor, tenant_id, body.at, body.note, body.lead
    )


@router.post("/workspaces/{tenant_id}/onboarding/summaries/refresh")
async def onboarding_refresh_summaries(tenant_id: uuid.UUID, staff: ConfigWriter) -> dict[str, Any]:
    """Rebuild what the client reads for each approved step (approvals stay)."""
    return await onboarding.refresh_summaries(staff.actor, tenant_id)


@router.put("/workspaces/{tenant_id}/onboarding/connection")
async def onboarding_connection(
    tenant_id: uuid.UUID, body: ConnectionIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding.save_connection(staff.actor, tenant_id, body.model_dump())


class AssistantIn(BaseModel):
    step: Literal["connect", "discovery", "mapping", "org", "metrics", "rules", "trial"]
    question: str = Field(max_length=2000)
    history: list[dict[str, Any]] = Field(default=[], max_length=20)
    cards: list[str] = Field(default=[], max_length=8)  # discovery cards mentioned with @


class MetricEditIn(BaseModel):
    edits: list[dict[str, Any]] = Field(max_length=50)


class AddMetricIn(BaseModel):
    template: str = Field(max_length=80)
    roles: list[str] = Field(min_length=1, max_length=20)
    name: str | None = Field(default=None, max_length=200)
    unit_value: float | None = None


class CustomDraftIn(BaseModel):
    name: str = Field(min_length=1, max_length=200)
    archetypes: list[str] = Field(min_length=1, max_length=3)
    instructions: str = Field(default="", max_length=4000)
    sql: str | None = Field(default=None, max_length=20000)
    playbook: str | None = None
    unit: str = Field(default="", max_length=30)
    higher_is_better: bool = True
    description: str = Field(default="", max_length=1000)
    params: list[dict[str, Any]] = Field(default_factory=list, max_length=10)


class CustomEditIn(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    sql: str = Field(max_length=20000)


class RuleEditIn(BaseModel):
    changes: list[dict[str, Any]] = Field(max_length=30)


@router.get("/workspaces/{tenant_id}/onboarding/guide")
async def onboarding_guide(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    """Profile, standard shapes, role types and rule settings, for the step pages."""
    return await onboarding.guide(tenant_id)


@router.post("/workspaces/{tenant_id}/onboarding/assistant")
async def onboarding_assistant(
    tenant_id: uuid.UUID, body: AssistantIn, staff: CurrentStaff
) -> dict[str, Any]:
    """Ask the AI about this workspace (team context)."""
    history = [assistant.Turn(**t) for t in body.history]
    return await assistant.team_ask(tenant_id, body.step, body.question, history, body.cards)


@router.post("/workspaces/{tenant_id}/onboarding/metrics/{step_id}/edit")
async def onboarding_edit_metrics(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: MetricEditIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding.edit_metrics(staff.actor, tenant_id, step_id, body.edits)


@router.post("/workspaces/{tenant_id}/onboarding/rules/{step_id}/edit")
async def onboarding_edit_rules(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: RuleEditIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding.edit_rules(staff.actor, tenant_id, step_id, body.changes)


@router.post("/workspaces/{tenant_id}/welcome")
async def resend_welcome(tenant_id: uuid.UUID, staff: ConfigWriter) -> dict[str, Any]:
    """Email the workspace owner a new set-your-password link."""
    return await onboarding.resend_welcome(staff.actor, tenant_id)


@router.post("/workspaces/{tenant_id}/onboarding/connection/mock")
async def onboarding_connect_mock(tenant_id: uuid.UUID, staff: ConfigWriter) -> dict[str, Any]:
    """Local only: one-click connection to the local mock warehouse (preset in .env)."""
    return await onboarding.connect_mock(staff.actor, tenant_id)


class SnapshotIn(BaseModel):
    snapshot_id: str


@router.post("/workspaces/{tenant_id}/onboarding/snapshot")
async def onboarding_select_snapshot(
    tenant_id: uuid.UUID, body: SnapshotIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Lab only: choose which saved warehouse snapshot discovery replays."""
    return await onboarding.select_snapshot(staff.actor, tenant_id, body.snapshot_id)


# Questions to the client and go-live (ADR 0027). Declared before /onboarding/{step}.


class ThreadIn(BaseModel):
    step: Literal["connect", "discovery", "mapping", "org", "metrics", "rules", "trial"]
    title: str = Field(default="", max_length=300)
    body: str = Field(max_length=4000)


class MessageIn(BaseModel):
    body: str = Field(max_length=4000)


class GoLiveIn(BaseModel):
    invite: bool = True


@router.post("/workspaces/{tenant_id}/onboarding/threads")
async def onboarding_ask(
    tenant_id: uuid.UUID, body: ThreadIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_collab.team_ask(
        staff.actor, tenant_id, body.step, body.title, body.body
    )


@router.post("/workspaces/{tenant_id}/onboarding/threads/{thread_id}/messages")
async def onboarding_reply(
    tenant_id: uuid.UUID, thread_id: uuid.UUID, body: MessageIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_collab.team_reply(staff.actor, tenant_id, thread_id, body.body)


@router.post("/workspaces/{tenant_id}/onboarding/threads/{thread_id}/resolve")
async def onboarding_resolve(
    tenant_id: uuid.UUID, thread_id: uuid.UUID, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_collab.team_resolve(staff.actor, tenant_id, thread_id)


@router.post("/workspaces/{tenant_id}/onboarding/org-draft/return")
async def onboarding_return_draft(
    tenant_id: uuid.UUID, body: MessageIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding_collab.return_draft(staff.actor, tenant_id, body.body)


class ReopenIn(BaseModel):
    note: str = Field(default="", max_length=1000)


@router.get("/onboarding")
async def onboarding_board(staff: CurrentStaff) -> dict[str, Any]:
    """Every workspace still onboarding, with its step, progress and whose turn it is."""
    return {"workspaces": await onboarding_collab.board()}


@router.post("/workspaces/{tenant_id}/onboarding/connect/approve")
async def onboarding_approve_connect(
    tenant_id: uuid.UUID, staff: ConfigWriter, body: ReasonIn | None = None
) -> dict[str, Any]:
    reason = body.reason if body else ""
    await onboarding_review.guard_approve(staff.actor, tenant_id, "connect", reason)
    return await onboarding_collab.approve_connect(staff.actor, tenant_id)


@router.post("/workspaces/{tenant_id}/onboarding/trial/approve")
async def onboarding_approve_trial(
    tenant_id: uuid.UUID, staff: ConfigWriter, body: ReasonIn | None = None
) -> dict[str, Any]:
    reason = body.reason if body else ""
    return await onboarding_collab.approve_trial(staff.actor, tenant_id, reason)


@router.post("/workspaces/{tenant_id}/onboarding/reopen/{step}")
async def onboarding_reopen(
    tenant_id: uuid.UUID,
    step: Literal["connect", "discovery", "mapping", "org", "metrics", "rules", "trial"],
    body: ReopenIn,
    staff: ConfigWriter,
) -> dict[str, Any]:
    """Team only: reopen a step to edit and update it (no reset of later steps)."""
    return await onboarding_collab.reopen(staff.actor, tenant_id, step, body.note)


@router.post("/workspaces/{tenant_id}/go-live")
async def go_live(tenant_id: uuid.UUID, body: GoLiveIn, staff: ConfigWriter) -> dict[str, Any]:
    return await onboarding_collab.go_live(staff.actor, tenant_id, body.invite)


@router.post("/workspaces/{tenant_id}/onboarding/{step}/cancel")
async def onboarding_cancel(
    tenant_id: uuid.UUID, step: OnboardingStepName, staff: ConfigWriter
) -> dict[str, Any]:
    """Stop a running (or stuck) AI step so it can be started again."""
    return await onboarding.cancel_step(staff.actor, tenant_id, step)


@router.post("/workspaces/{tenant_id}/onboarding/{step}")
async def onboarding_propose(
    tenant_id: uuid.UUID, step: OnboardingStepName, body: NotesIn, staff: ConfigWriter
) -> dict[str, Any]:
    """Start an agent proposal (spends tokens). Runs in the background; poll the state."""
    start = {
        "discovery": onboarding.start_discovery,
        "mapping": onboarding.start_mapping,
        "org": onboarding.start_org,
        "metrics": onboarding.start_metrics,
        "rules": onboarding.start_rules,
    }[step]
    return await start(staff.actor, tenant_id, body.notes)


@router.post("/workspaces/{tenant_id}/onboarding/mapping/{step_id}/recheck")
async def onboarding_recheck(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: MappingEditIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding.recheck_mapping(staff.actor, tenant_id, step_id, body.archetypes)


@router.post("/workspaces/{tenant_id}/onboarding/steps/{step_id}/approve")
async def onboarding_approve(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: ApproveIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await onboarding.approve(staff.actor, tenant_id, step_id, body.keys, body.reason)


# ---- the team and your own account (ADR 0023, 0024) -----------------------------------------


class StaffIn(BaseModel):
    email: str = Field(max_length=320)
    name: str = Field(default="", max_length=200)
    staff_role: Literal["admin", "developer"] = "developer"
    password: str = Field(max_length=200)


class StaffUpdateIn(BaseModel):
    staff_role: Literal["admin", "developer"] | None = None
    active: bool | None = None


class ChangePasswordIn(BaseModel):
    current: str = Field(max_length=200)
    new: str = Field(max_length=200)


@router.get("/staff")
async def staff_list(staff: CurrentStaff) -> list[dict[str, Any]]:
    return await auth_service.list_staff()


@router.post("/staff")
async def staff_create(body: StaffIn, staff: StaffManager) -> dict[str, Any]:
    return await auth_service.create_staff(
        staff.actor, body.email, body.name, body.staff_role, body.password
    )


@router.patch("/staff/{staff_id}")
async def staff_update(
    staff_id: uuid.UUID, body: StaffUpdateIn, staff: StaffManager
) -> dict[str, Any]:
    deactivate = None if body.active is None else not body.active
    return await auth_service.update_staff(
        staff.staff_id, staff.actor, staff_id, body.staff_role, deactivate
    )


@router.post("/account/password")
async def change_password(
    body: ChangePasswordIn, staff: CurrentStaff, auth: Annotated[TokenAuth, Depends(get_auth)]
) -> dict[str, str]:
    token = await auth_service.change_password(auth, "staff", staff.email, body.current, body.new)
    return {"token": token}


@router.post("/account/sign-out-everywhere")
async def sign_out_everywhere(staff: CurrentStaff) -> dict[str, Any]:
    return await auth_service.sign_out_everywhere("staff", staff.email)


# ---- Metric library and custom metrics (onboarding, metrics step) ---------------------------


@router.get("/workspaces/{tenant_id}/onboarding/metric-library")
async def metric_library(tenant_id: uuid.UUID, staff: CurrentStaff) -> dict[str, Any]:
    """What this customer's data can feed (found) and cannot (not found), plus custom metrics."""
    return await custom_metrics.library(tenant_id)


@router.post("/workspaces/{tenant_id}/onboarding/metrics/{step_id}/add")
async def onboarding_add_metric(
    tenant_id: uuid.UUID, step_id: uuid.UUID, body: AddMetricIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await custom_metrics.add_to_plan(
        staff.actor, tenant_id, step_id, body.model_dump(exclude_none=True)
    )


@router.delete("/workspaces/{tenant_id}/onboarding/metrics/{step_id}/metric/{metric_key}")
async def onboarding_remove_metric(
    tenant_id: uuid.UUID, step_id: uuid.UUID, metric_key: str, staff: ConfigWriter
) -> dict[str, Any]:
    return await custom_metrics.remove_from_plan(staff.actor, tenant_id, step_id, metric_key)


@router.post("/workspaces/{tenant_id}/onboarding/custom-metrics")
async def custom_metric_draft(
    tenant_id: uuid.UUID, body: CustomDraftIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await custom_metrics.draft_custom(staff.actor, tenant_id, body.model_dump())


@router.put("/workspaces/{tenant_id}/onboarding/custom-metrics/{custom_id}")
async def custom_metric_edit(
    tenant_id: uuid.UUID, custom_id: uuid.UUID, body: CustomEditIn, staff: ConfigWriter
) -> dict[str, Any]:
    return await custom_metrics.edit_draft(
        staff.actor, tenant_id, custom_id, body.model_dump(exclude_none=True)
    )


@router.post("/workspaces/{tenant_id}/onboarding/custom-metrics/{custom_id}/approve")
async def custom_metric_approve(
    tenant_id: uuid.UUID, custom_id: uuid.UUID, staff: ConfigWriter
) -> dict[str, Any]:
    return await custom_metrics.approve_custom(staff.actor, tenant_id, custom_id)


@router.delete("/workspaces/{tenant_id}/onboarding/custom-metrics/{custom_id}")
async def custom_metric_retire(
    tenant_id: uuid.UUID, custom_id: uuid.UUID, staff: ConfigWriter
) -> dict[str, Any]:
    return await custom_metrics.retire_custom(staff.actor, tenant_id, custom_id)
