"""/api/onboarding and /api/notifications: the client's side of onboarding (ADR 0027).

Owners and Admins see progress, answer questions and build their org chart. Members only learn
that the workspace is being set up. Nothing technical (SQL, agent inputs, checks) is served here.
"""

import uuid
from typing import Any, Literal

from fastapi import APIRouter, Response
from pydantic import BaseModel, Field

from app.core.auth import CurrentPrincipal
from app.domain import org_import
from app.services import assistant
from app.services import onboarding_collab as collab

router = APIRouter(tags=["onboarding"])

Step = Literal["connect", "discovery", "mapping", "org", "metrics", "rules", "trial"]


class ThreadIn(BaseModel):
    step: Step
    title: str = Field(default="", max_length=300)
    body: str = Field(max_length=4000)


class MessageIn(BaseModel):
    body: str = Field(max_length=4000)


class DraftIn(BaseModel):
    nodes: list[dict[str, Any]] = Field(max_length=org_import.MAX_NODES)


class FileIn(BaseModel):
    filename: str = Field(max_length=200)
    content_b64: str = Field(max_length=7_200_000)  # 5 MB once decoded


class TemplateIn(BaseModel):
    key: str = Field(max_length=40)


class MicrosoftIn(BaseModel):
    tenant: str = Field(max_length=100)
    state: str = Field(max_length=64)


class ReadIn(BaseModel):
    ids: list[uuid.UUID] | None = None


@router.get("/onboarding")
async def view(principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.client_view(principal)


@router.post("/onboarding/threads")
async def ask(body: ThreadIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.client_ask(principal, body.step, body.title, body.body)


@router.post("/onboarding/go-live")
async def go_live(principal: CurrentPrincipal) -> dict[str, Any]:
    """The client goes live after a successful trial (ADR 0030)."""
    return await collab.client_go_live(principal)


@router.post("/onboarding/threads/{thread_id}/messages")
async def reply(
    thread_id: uuid.UUID, body: MessageIn, principal: CurrentPrincipal
) -> dict[str, Any]:
    return await collab.client_reply(principal, thread_id, body.body)


@router.post("/onboarding/threads/{thread_id}/resolve")
async def resolve(thread_id: uuid.UUID, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.client_resolve(principal, thread_id)


@router.put("/onboarding/org-draft")
async def save_draft(body: DraftIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.save_draft(principal, body.nodes)


@router.post("/onboarding/org-draft/submit")
async def submit_draft(principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.submit_draft(principal)


@router.post("/onboarding/org-draft/withdraw")
async def withdraw_draft(principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.withdraw_draft(principal)


@router.get("/onboarding/org-draft/templates")
async def templates(principal: CurrentPrincipal) -> dict[str, Any]:
    return {"templates": org_import.templates(principal.locale)}


@router.get("/onboarding/org-draft/template.xlsx")
async def template_file(principal: CurrentPrincipal) -> Response:
    data = org_import.build_xlsx(org_import.template_rows(principal.locale))
    return Response(
        data,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": 'attachment; filename="org-chart-template.xlsx"'},
    )


@router.post("/onboarding/org-draft/import/file")
async def import_file(body: FileIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.import_file(principal, body.filename, body.content_b64)


@router.post("/onboarding/org-draft/import/template")
async def import_template(body: TemplateIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.import_template(principal, body.key)


@router.get("/onboarding/org-draft/microsoft")
async def microsoft_url(principal: CurrentPrincipal) -> dict[str, Any]:
    return collab.microsoft_consent_url(principal)


@router.post("/onboarding/org-draft/import/microsoft")
async def import_microsoft(body: MicrosoftIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.import_microsoft(principal, body.tenant, body.state)


class AskIn(BaseModel):
    step: Step
    question: str = Field(max_length=2000)
    history: list[dict[str, Any]] = Field(default=[], max_length=20)


class SuggestionsIn(BaseModel):
    step: Literal["metrics", "rules"]
    metrics: list[dict[str, Any]] = Field(default=[], max_length=20)
    rules: list[dict[str, Any]] = Field(default=[], max_length=20)
    note: str = Field(default="", max_length=2000)


@router.post("/onboarding/assistant")
async def ask_ai(body: AskIn, principal: CurrentPrincipal) -> dict[str, Any]:
    """Plain answers about the client's onboarding; suggestions on metrics and rules."""
    history = [assistant.Turn(**t) for t in body.history]
    return await assistant.client_ask(principal, body.step, body.question, history)


@router.post("/onboarding/suggestions")
async def send_suggestions(body: SuggestionsIn, principal: CurrentPrincipal) -> dict[str, Any]:
    """Send chosen AI suggestions to our team, as a question on the step."""
    return await assistant.client_send(principal, body.step, body.metrics, body.rules, body.note)


@router.get("/onboarding/trial")
async def trial(principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.client_trial(principal)


@router.get("/notifications")
async def notifications(principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.notifications(principal)


@router.post("/notifications/read")
async def read(body: ReadIn, principal: CurrentPrincipal) -> dict[str, Any]:
    return await collab.mark_read(principal, body.ids)
