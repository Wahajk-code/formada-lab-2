"""/internal/*: called only by n8n. Service token, idempotency key on every POST, and a
{"status": "ok" | "skipped" | "failed" | "busy", ...} body that workflows branch on.

HTTP status: 200 for every handled outcome (including busy/skipped/failed),
503 for unexpected errors so n8n's retry-on-fail kicks in (the idempotency key is released).
"""

import hmac
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field

from app.core.logging import bind_request_context
from app.core.settings import get_settings
from app.services import digest, idempotency, ops, outcomes, pipeline
from app.services import feedback as feedback_service
from app.services import runs as run_service
from app.services.runs import RunNotRunning


def require_service_token(authorization: Annotated[str, Header()] = "") -> None:
    expected = get_settings().internal_service_token
    token = authorization.removeprefix("Bearer ").strip()
    if not expected or not hmac.compare_digest(token.encode(), expected.encode()):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid service token")


router = APIRouter(
    prefix="/internal", tags=["internal"], dependencies=[Depends(require_service_token)]
)
IdemKey = Annotated[str, Header(alias="Idempotency-Key", min_length=3, max_length=300)]


class TenantIn(BaseModel):
    tenant_id: uuid.UUID


class RunIn(TenantIn):
    run_id: uuid.UUID


class RoleStepIn(RunIn):
    role_node_id: uuid.UUID


class CreateRunIn(TenantIn):
    type: Literal["weekly", "daily_check", "remeasure", "manual"] = "weekly"
    slot: datetime
    execution_id: str | None = Field(default=None, max_length=40)


class CompileIn(TenantIn):
    feedback_id: uuid.UUID | None = None  # set when WF5 was started by the feedback webhook


class DigestIn(TenantIn):
    slot: datetime


class FailExecutionIn(BaseModel):
    execution_id: str = Field(max_length=40)
    workflow: str = Field(default="", max_length=200)
    error: str = Field(max_length=10_000)


class FailRunIn(TenantIn):
    error: str = Field(max_length=10_000)


class FailStepIn(TenantIn):
    role_node_id: uuid.UUID | None = None
    step: str = Field(max_length=40)
    error: str = Field(max_length=10_000)


Result = dict[str, Any]


async def _once(
    tenant_id: uuid.UUID, key: str, endpoint: str, fn: Callable[[], Awaitable[Result]]
) -> Result:
    bind_request_context(tenant_id=str(tenant_id))
    try:
        return await idempotency.run_once(tenant_id, key, endpoint, fn)
    except RunNotRunning:
        return {"status": "skipped", "reason": "run is not running"}


@router.get("/tenants/due")
async def tenants_due(
    type: Literal["weekly", "daily_check", "remeasure", "digest"] = "weekly",
    force: Annotated[bool, Query(description="ignore schedule (manual/dev runs)")] = False,
    tenant_id: Annotated[str, Query(description="only this tenant (manual run)")] = "",
) -> Result:
    due = await run_service.due_tenants(type, datetime.now(UTC), force)
    if tenant_id:
        due["tenants"] = [t for t in due["tenants"] if t["tenant_id"] == tenant_id]
    return due


@router.get("/tenants")
async def tenants() -> Result:
    """Every tenant (WF5 nightly compile)."""
    return await run_service.all_tenants()


@router.post("/runs")
async def create_run(body: CreateRunIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "runs.create",
        lambda: run_service.create_run(body.tenant_id, body.type, body.slot, body.execution_id),
    )  # fmt: skip


@router.post("/runs/{run_id}/finish")
async def finish_run(run_id: uuid.UUID, body: TenantIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "runs.finish", lambda: run_service.finish_run(body.tenant_id, run_id)
    )


@router.post("/runs/{run_id}/fail")
async def fail_run(run_id: uuid.UUID, body: FailRunIn) -> Result:
    """Called by the error workflow. Not idempotency-keyed: failing twice is harmless."""
    return await run_service.fail_run(body.tenant_id, run_id, body.error)


@router.post("/runs/fail-by-execution")
async def fail_by_execution(body: FailExecutionIn) -> Result:
    """Error workflow: mark every running run started by that n8n execution as failed."""
    return await run_service.fail_by_execution(body.execution_id, f"[{body.workflow}] {body.error}")


@router.post("/runs/{run_id}/steps/fail")
async def fail_step(run_id: uuid.UUID, body: FailStepIn) -> Result:
    """Called after n8n exhausted its retries for one step; the loop then continues."""
    return await run_service.fail_step(
        body.tenant_id, run_id, body.role_node_id, body.step, body.error
    )


@router.post("/metrics/run")
async def metrics_run(body: RunIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id,
        key,
        "metrics.run",
        lambda: pipeline.run_metrics(body.tenant_id, body.run_id),
    )


@router.post("/signals/detect")
async def signals_detect(body: RoleStepIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "signals.detect",
        lambda: pipeline.detect_signals(body.tenant_id, body.run_id, body.role_node_id),
    )  # fmt: skip


@router.post("/prompt/build")
async def prompt_build(body: RoleStepIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "prompt.build",
        lambda: pipeline.build_role_prompt(body.tenant_id, body.run_id, body.role_node_id),
    )  # fmt: skip


@router.post("/llm/generate")
async def llm_generate(body: RoleStepIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "llm.generate",
        lambda: pipeline.generate_cards(body.tenant_id, body.run_id, body.role_node_id),
    )  # fmt: skip


@router.post("/cards/ingest")
async def cards_ingest(body: RoleStepIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "cards.ingest",
        lambda: pipeline.ingest_cards(body.tenant_id, body.run_id, body.role_node_id),
    )  # fmt: skip


@router.post("/rollup")
async def rollup(body: RunIn, key: IdemKey) -> Result:
    return await _once(
        body.tenant_id, key, "rollup", lambda: pipeline.rollup(body.tenant_id, body.run_id)
    )


@router.post("/daily/plan")
async def daily_plan(body: RunIn, key: IdemKey) -> Result:
    """WF2: roles to run today (daily-cadence roles and daily_check threshold breaches)."""
    return await _once(
        body.tenant_id, key, "daily.plan", lambda: pipeline.daily_plan(body.tenant_id, body.run_id)
    )


@router.post("/outcomes/measure")
async def outcomes_measure(body: RunIn, key: IdemKey) -> Result:
    """WF3: midpoint and end measurements of initiatives that are due."""
    return await _once(
        body.tenant_id, key, "outcomes.measure",
        lambda: outcomes.measure(body.tenant_id, body.run_id),
    )  # fmt: skip


@router.post("/feedback/compile")
async def feedback_compile(body: CompileIn, key: IdemKey) -> Result:
    """WF5: turn repeated feedback into proposed rules for review."""
    return await _once(
        body.tenant_id, key, "feedback.compile",
        lambda: feedback_service.compile_rules(body.tenant_id),
    )  # fmt: skip


@router.post("/digest/send")
async def digest_send(body: DigestIn, key: IdemKey) -> Result:
    """WF4: weekly email of new cards and value captured, per person."""
    return await _once(
        body.tenant_id, key, "digest.send", lambda: digest.send(body.tenant_id, body.slot)
    )


@router.post("/health")
async def health(check_connections: bool = True) -> Result:
    return await ops.health(check_connections)
