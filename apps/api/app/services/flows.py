"""Run the flows in-process (ADR 0034). This is everything n8n used to do, and nothing more: find
the workspaces that are due, call the steps in order, try each call three times, and mark a step or
a run failed when the tries run out. The logic itself lives in the services the steps call.

Every call goes through the idempotency store with the same keys n8n sent, so a repeat of a step
(a retry, a second start of the same slot) writes nothing.

`Ports` is the list of things a flow calls. `real_ports()` wires the services; tests pass fakes, so
every branch can be checked without a database."""

import asyncio
import uuid
from collections import deque
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any

from app.core.logging import bind_request_context, get_logger
from app.domain import flows as fl
from app.domain.flows import Execution, Flow, Trigger

log = get_logger(__name__)

Result = dict[str, Any]
Call = Callable[[], Awaitable[Result]]
HISTORY_SIZE = 25
HISTORY: dict[str, deque[Execution]] = {k: deque(maxlen=HISTORY_SIZE) for k in fl.FLOWS}
_locks: dict[str, asyncio.Lock] = {k: asyncio.Lock() for k in fl.FLOWS}
_tasks: set[asyncio.Task[Any]] = set()  # started in the background; kept so they are not collected


@dataclass
class Ports:
    due_tenants: Callable[[str, datetime, bool], Awaitable[Result]]
    all_tenants: Callable[[], Awaitable[Result]]
    create_run: Callable[[uuid.UUID, str, datetime, str | None], Awaitable[Result]]
    finish_run: Callable[[uuid.UUID, uuid.UUID], Awaitable[Result]]
    fail_run: Callable[[uuid.UUID, uuid.UUID, str], Awaitable[Result]]
    fail_step: Callable[[uuid.UUID, uuid.UUID, uuid.UUID | None, str, str], Awaitable[Result]]
    # tenant steps: (tenant, run) and role steps: (tenant, run, role), by step key
    tenant_step: dict[str, Callable[[uuid.UUID, uuid.UUID], Awaitable[Result]]]
    role_step: dict[str, Callable[[uuid.UUID, uuid.UUID, uuid.UUID], Awaitable[Result]]]
    digest_send: Callable[[uuid.UUID, datetime], Awaitable[Result]]
    feedback_compile: Callable[[uuid.UUID], Awaitable[Result]]
    health: Callable[[], Awaitable[Result]]
    once: Callable[[uuid.UUID, str, str, Call], Awaitable[Result]]
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep


def real_ports() -> Ports:
    from app.services import digest, idempotency, ops, outcomes, pipeline, validation
    from app.services import feedback as feedback_service
    from app.services import runs as run_service

    async def once(tenant_id: uuid.UUID, key: str, endpoint: str, fn: Call) -> Result:
        try:
            return await idempotency.run_once(tenant_id, key, endpoint, fn)
        except run_service.RunNotRunning:
            return {"status": "skipped", "reason": "run is not running"}

    return Ports(
        due_tenants=run_service.due_tenants,
        all_tenants=run_service.all_tenants,
        create_run=run_service.create_run,
        finish_run=run_service.finish_run,
        fail_run=run_service.fail_run,
        fail_step=run_service.fail_step,
        tenant_step={
            "metrics_run": pipeline.run_metrics,
            "daily_plan": pipeline.daily_plan,
            "outcomes_measure": outcomes.measure,
            "rollup": pipeline.rollup,
            "reconcile": validation.reconcile_run,
            "finish_run": run_service.finish_run,
        },
        role_step={
            "signals_detect": pipeline.detect_signals,
            "prompt_build": pipeline.build_role_prompt,
            "llm_generate": pipeline.generate_cards,
            "cards_ingest": pipeline.ingest_cards,
        },
        digest_send=digest.send,
        feedback_compile=feedback_service.compile_rules,
        health=lambda: ops.health(True),
        once=once,
    )


# ---- one call, tried three times ----------------------------------------------------------------


async def attempt(
    ports: Ports, tenant_id: uuid.UUID | None, key: str, endpoint: str, fn: Call,
    timeout_s: int = 120,
) -> tuple[Result | None, str | None]:  # fmt: skip
    """Call `fn` up to TRIES times, WAIT_S apart. Returns (result, None), or (None, the last error)
    when every try failed. A `busy`, `skipped` or `failed` answer is a result, not an error: it is
    never retried (the services use it to say "not now" or "nothing to do")."""
    error = ""
    for tried in range(1, fl.TRIES + 1):
        try:
            if tenant_id is None:
                return await asyncio.wait_for(fn(), timeout_s), None
            return await asyncio.wait_for(ports.once(tenant_id, key, endpoint, fn), timeout_s), None
        except Exception as exc:
            error = f"{type(exc).__name__}: {exc}"[:500] or type(exc).__name__
            log.warning("flow.try_failed", endpoint=endpoint, tried=tried, error=error[:200])
            if tried < fl.TRIES:
                await ports.sleep(fl.WAIT_S)
    return None, error


# ---- the role pipeline (n8n WF1a) ---------------------------------------------------------------


async def run_role(
    ports: Ports, flow: Flow, tenant_id: uuid.UUID, run_id: uuid.UUID, role_id: uuid.UUID
) -> str:
    """Signals, prompt, AI, ingest for one role. Stops at the first step that is not ok: a skipped
    step (nothing to do) ends the role quietly, a step whose tries ran out is marked failed."""
    for step in flow.role_steps:
        call = ports.role_step[step.key]

        async def one(call: Callable[..., Awaitable[Result]] = call) -> Result:
            return await call(tenant_id, run_id, role_id)

        res, err = await attempt(
            ports, tenant_id, fl.key_role(run_id, role_id, step.key), step.key, one, step.timeout_s
        )
        if err is not None:
            await ports.fail_step(tenant_id, run_id, role_id, step.key, err)
            return "failed"
        assert res is not None
        if res.get("status") != "ok":
            return str(res.get("status"))
    return "ok"


async def _tenant_step(
    ports: Ports, key: str, tenant_id: uuid.UUID, run_id: uuid.UUID
) -> tuple[Result | None, str | None]:
    fn = ports.tenant_step[key]
    return await attempt(
        ports, tenant_id, fl.key_tenant(run_id, key), key,
        lambda: fn(tenant_id, run_id), fl.STEPS[key].timeout_s,
    )  # fmt: skip


# ---- one workspace, one run (n8n WF1, WF2, WF3) -------------------------------------------------


async def run_workspace(ports: Ports, flow: Flow, due: Result, token: str) -> str:
    """Open the run and go through the flow's steps. Returns ok, partial, failed or skipped."""
    tenant_id = uuid.UUID(due["tenant_id"])
    slot = datetime.fromisoformat(due["slot"])
    bind_request_context(tenant_id=str(tenant_id))
    assert flow.run_type is not None
    res, err = await attempt(
        ports, tenant_id, fl.key_run(tenant_id, flow.run_type, slot.isoformat(), token),
        "runs.create", lambda: ports.create_run(tenant_id, flow.run_type or "", slot, token),
    )  # fmt: skip
    if err is not None or res is None or res.get("status") != "ok":
        log.warning("flow.run_not_opened", flow=flow.key, why=err or (res or {}).get("reason"))
        return "skipped"
    run_id = uuid.UUID(res["run_id"])
    bind_request_context(tenant_id=str(tenant_id), run_id=str(run_id))
    try:
        return await _steps(ports, flow, due, tenant_id, run_id)
    except Exception as exc:
        log.exception("flow.crashed", flow=flow.key)
        await ports.fail_run(tenant_id, run_id, f"[{flow.key}] {type(exc).__name__}: {exc}"[:4000])
        return "failed"


async def _steps(
    ports: Ports, flow: Flow, due: Result, tenant_id: uuid.UUID, run_id: uuid.UUID
) -> str:
    roles: list[Result] = list(due.get("role_nodes", []))
    if flow.key == "daily_check":
        _, err = await _tenant_step(ports, "metrics_run", tenant_id, run_id)
        if err is not None:
            return await _fail(ports, tenant_id, run_id, f"daily metrics failed: {err}")
        plan, err = await _tenant_step(ports, "daily_plan", tenant_id, run_id)
        if err is not None:
            return await _fail(ports, tenant_id, run_id, f"daily plan failed: {err}")
        assert plan is not None
        roles = list(plan.get("role_nodes", [])) if plan.get("status") == "ok" else []
        if not roles:  # nobody to run today: close the run
            return await _finish(ports, tenant_id, run_id)
    elif flow.key == "weekly":
        _, err = await _tenant_step(ports, "metrics_run", tenant_id, run_id)
        if err is not None:
            return await _fail(ports, tenant_id, run_id, f"metrics phase failed: {err}")
    elif flow.key == "remeasure":
        _, err = await _tenant_step(ports, "outcomes_measure", tenant_id, run_id)
        if err is not None:
            return await _fail(ports, tenant_id, run_id, f"outcome measurement failed: {err}")
        roles = []
    for role in roles:  # one role at a time, as before
        bind_request_context(tenant_id=str(tenant_id), run_id=str(run_id))
        await run_role(ports, flow, tenant_id, run_id, uuid.UUID(str(role["id"])))
    if flow.key in ("weekly", "daily_check"):  # our numbers against the client's own figures
        _, err = await _tenant_step(ports, "reconcile", tenant_id, run_id)
        if err is not None:
            log.warning("flow.reconcile_failed", flow=flow.key, error=err[:200])
    _, err = await _tenant_step(ports, "rollup", tenant_id, run_id)
    if err is not None:
        log.warning("flow.rollup_failed", flow=flow.key, error=err[:200])  # the run still finishes
    return await _finish(ports, tenant_id, run_id)


async def _fail(ports: Ports, tenant_id: uuid.UUID, run_id: uuid.UUID, error: str) -> str:
    await ports.fail_run(tenant_id, run_id, error)
    return "failed"


async def _finish(ports: Ports, tenant_id: uuid.UUID, run_id: uuid.UUID) -> str:
    res, err = await _tenant_step(ports, "finish_run", tenant_id, run_id)
    if err is not None or res is None:
        log.warning("flow.finish_failed", error=(err or "")[:200])
        return "failed"
    status = str(res.get("run_status") or "ok")
    return "ok" if status == "succeeded" else status  # the run service says "succeeded"


# ---- the other flows (n8n WF4, WF5, WF7) --------------------------------------------------------


async def run_digest(ports: Ports, due: Result, token: str) -> str:
    tenant_id, slot = uuid.UUID(due["tenant_id"]), datetime.fromisoformat(due["slot"])
    bind_request_context(tenant_id=str(tenant_id))
    res, err = await attempt(
        ports, tenant_id, fl.key_digest(tenant_id, slot.isoformat(), token), "digest.send",
        lambda: ports.digest_send(tenant_id, slot),
    )  # fmt: skip
    return "failed" if err else str((res or {}).get("status", "ok"))


async def run_feedback(ports: Ports, tenant_id: uuid.UUID, token: str) -> str:
    bind_request_context(tenant_id=str(tenant_id))
    res, err = await attempt(
        ports, tenant_id, fl.key_feedback(tenant_id, token), "feedback.compile",
        lambda: ports.feedback_compile(tenant_id),
    )  # fmt: skip
    return "failed" if err else str((res or {}).get("status", "ok"))


async def run_health(ports: Ports) -> tuple[str, str]:
    res, err = await attempt(ports, None, "", "health", ports.health, fl.HEALTH.timeout_s)
    if err is not None:
        log.error("health.check_failed", error=err[:300])
        return "failed", err
    assert res is not None
    if (
        res.get("healthy") is False
    ):  # n8n's "Alert" node did nothing either: it was a place to wire one
        log.error("health.unhealthy", alerts=res.get("alerts"))
        return "partial", "unhealthy: " + "; ".join(str(a) for a in (res.get("alerts") or [])[:5])
    return "ok", ""


# ---- start a flow -------------------------------------------------------------------------------


def _record(ex: Execution) -> None:
    HISTORY[ex.flow].appendleft(ex)


def _worst(statuses: list[str]) -> str:
    if not statuses:
        return "skipped"
    if all(s == "skipped" for s in statuses):
        return "skipped"
    if any(s == "failed" for s in statuses):
        return "partial" if any(s in ("ok", "partial") for s in statuses) else "failed"
    return "partial" if any(s == "partial" for s in statuses) else "ok"


async def run_flow(
    flow_key: str, *, trigger: Trigger = "scheduled", tenant_id: uuid.UUID | None = None,
    feedback_id: uuid.UUID | None = None, now: datetime | None = None, ports: Ports | None = None,
) -> Execution:  # fmt: skip
    """Run one flow to the end. `tenant_id` limits it to one workspace and ignores the schedule (a
    manual run, or the feedback of one workspace); without it the flow covers the workspaces due."""
    flow = fl.FLOWS[flow_key]
    ports = ports or real_ports()
    now = now or datetime.now(UTC)
    exec_id = uuid.uuid4().hex[:12]
    token = fl.SCHEDULED if trigger == "scheduled" else exec_id
    ex = Execution(flow_key, trigger, now)
    _record(ex)
    scoped = tenant_id is not None
    lock = _locks[flow_key]
    if not scoped and lock.locked():
        ex.status, ex.ended_at, ex.note = (
            "skipped",
            datetime.now(UTC),
            "the previous start of this flow is still going",
        )
        return ex
    try:
        async with lock if not scoped else _nullcontext():
            statuses = await _dispatch(flow, ports, ex, trigger, tenant_id, feedback_id, now, token)
            ex.status = _worst(statuses) if flow_key != "health" else ex.status
    except Exception as exc:
        log.exception("flow.failed", flow=flow_key)
        ex.status, ex.note = "failed", f"{type(exc).__name__}: {exc}"[:300]
    ex.ended_at = datetime.now(UTC)
    log.info(
        "flow.done", flow=flow_key, status=ex.status, workspaces=ex.workspaces, trigger=trigger
    )
    return ex


async def _dispatch(
    flow: Flow, ports: Ports, ex: Execution, trigger: Trigger, tenant_id: uuid.UUID | None,
    feedback_id: uuid.UUID | None, now: datetime, token: str,
) -> list[str]:  # fmt: skip
    if flow.key == "health":
        ex.status, note = await run_health(ports)
        ex.note = note
        return [ex.status]
    if flow.key == "feedback":
        if tenant_id is not None:
            ids = [tenant_id]
        else:
            listing = await ports.all_tenants()
            ids = [uuid.UUID(t["tenant_id"]) for t in listing.get("tenants", [])]
        # Feedback just given has its own key; otherwise once a day, or every time when manual.
        tag = str(feedback_id) if feedback_id else f"{now:%Y-%m-%d}:{token}"
        ex.workspaces = len(ids)
        return [await run_feedback(ports, tid, tag) for tid in ids]
    force = trigger != "scheduled"
    kind = "digest" if flow.key == "digest" else str(flow.run_type)
    listing = await ports.due_tenants(kind, now, force)
    due = [
        t
        for t in listing.get("tenants", [])
        if tenant_id is None or t["tenant_id"] == str(tenant_id)
    ]
    ex.workspaces = len(due)
    out = []
    for t in due:  # one workspace at a time
        out.append(
            await run_digest(ports, t, token)
            if flow.key == "digest"
            else await run_workspace(ports, flow, t, token)
        )
    return out


class _nullcontext:
    async def __aenter__(self) -> None:
        return None

    async def __aexit__(self, *exc: object) -> None:
        return None


def launch(flow_key: str, **kw: Any) -> asyncio.Task[Execution]:
    """Start a flow in the background (a manual run from the console, feedback just given)."""
    task = asyncio.create_task(run_flow(flow_key, **kw))
    _tasks.add(task)
    task.add_done_callback(_tasks.discard)
    return task
