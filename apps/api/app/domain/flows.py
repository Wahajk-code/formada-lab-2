# ruff: noqa: E501  (the one-line descriptions are product copy for the dashboard)
"""The workflows of the app, as data (ADR 0034).

The in-app scheduler runs these and the console draws them, so what you see is what runs. Every flow
is a list of steps. A step is one call into the API's own services; the services hold all the logic
and every one of them is idempotent, so a repeated step writes nothing.

Pure: no I/O. `services/flows.py` runs them, `services/scheduler.py` decides when.

Words: a *flow* is one workflow (weekly run, daily check ...); a *step* is one call; a *role step*
runs once for each role of a workspace; a *slot* is the moment a flow is due.
"""

from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Literal

TRIES = 3  # attempts per call, in total (ADR 0009)
WAIT_S = 5  # seconds between attempts
MAX_RUNS_PER_TENANT = 2  # also enforced by the run lock in the API

Trigger = Literal["scheduled", "manual", "feedback"]
Scope = Literal["workspace", "role"]


@dataclass(frozen=True)
class Step:
    key: str  # also the step name recorded on the run and part of its idempotency key
    label: str
    does: str  # one plain line for the dashboard
    scope: Scope = "workspace"
    reads: tuple[str, ...] = ()  # tables, for the data picture
    writes: tuple[str, ...] = ()
    ai: bool = False  # calls the AI model (costs tokens)
    timeout_s: int = 120  # a call that takes longer counts as a failed try
    # What happens when the step still fails after its tries.
    on_error: Literal["fail_run", "fail_step", "log"] = "fail_step"
    failure: str = ""  # that, in words
    skips: str = ""  # what a "skipped" or "busy" answer means here, in words (not an error)


@dataclass(frozen=True)
class Schedule:
    minute: int
    hour: int | None = None  # None: every hour
    note: str = ""  # when it really runs for a workspace (its own time zone)

    def describe(self) -> str:
        when = (
            f"every hour at :{self.minute:02d}"
            if self.hour is None
            else f"every day at {self.hour:02d}:{self.minute:02d} UTC"
        )
        return when


@dataclass(frozen=True)
class Flow:
    key: str
    name: str
    purpose: str
    schedule: Schedule | None
    steps: tuple[Step, ...]
    run_type: str | None = None  # the Run type it records, when it records one
    window: timedelta = timedelta(hours=1)  # how late a missed tick may still fire
    also: str = ""  # other ways it starts

    @property
    def role_steps(self) -> tuple[Step, ...]:
        return tuple(s for s in self.steps if s.scope == "role")


# ---- the steps ----------------------------------------------------------------------------------

DUE = Step(
    "due_tenants", "Find workspaces due",
    "Looks at each workspace's own clock and picks the ones whose slot has come and that have work.",
    reads=("tenant", "run", "role_metric", "initiative", "person"),
)  # fmt: skip
CREATE_RUN = Step(
    "create_run", "Open a run",
    f"Starts a run for the slot. A workspace runs at most {MAX_RUNS_PER_TENANT} at once; a repeat of the same slot does nothing.",
    reads=("run",), writes=("run",),
    skips="Already has a run for this slot, or is at its limit of 2: this workspace is skipped.", failure="No run is opened and the workspace is skipped until the next tick.",
    on_error="log",
)  # fmt: skip
METRICS = Step(
    "metrics_run", "Run the metrics",
    "Runs every metric on the customer's data through their semantic view and stores the numbers.",
    reads=("role_metric", "metric", "archetype_mapping", "warehouse_connection"),
    writes=("metric_snapshot", "run_step"), timeout_s=900,
    on_error="fail_run", failure="The whole run is marked failed and no role runs.",
)  # fmt: skip
SIGNALS = Step(
    "signals_detect", "Find signals",
    "Deterministic code compares each role's numbers with their usual level and picks what is worth a card.",
    scope="role", reads=("metric_snapshot", "role_metric"), writes=("signal", "run_step"),
    skips="No signal worth a card: this role ends quietly.", failure="This role is marked failed. Other roles carry on.",
)  # fmt: skip
PROMPT = Step(
    "prompt_build", "Build the prompt",
    "Puts the role's chosen signals, its past feedback and its rules into the request for the AI.",
    scope="role", reads=("signal", "feedback"), writes=("run_step",),
    skips="Nothing selected to write about: this role ends quietly.", failure="This role is marked failed. Other roles carry on.",
)  # fmt: skip
LLM = Step(
    "llm_generate", "Write the cards",
    "The AI writes ranked cards from the signals. It sees numbers only, never rows.",
    scope="role", reads=("run_step",), writes=("llm_call_log", "run_step"), ai=True, timeout_s=300,
    skips="No prompt was built: this role ends quietly.", failure="This role is marked failed. Other roles carry on.",
)  # fmt: skip
INGEST = Step(
    "cards_ingest", "Check and save the cards",
    "Code checks every card (numbers must match the signals), then saves the ones that pass and logs the rest.",
    scope="role", reads=("run_step", "signal"), writes=("insight_card", "card_rejection", "run_step"),
    skips="Nothing came back to save: this role ends quietly.", failure="This role is marked failed. Other roles carry on.",
)  # fmt: skip
ROLLUP = Step(
    "rollup", "Refresh the roll-up",
    "Rebuilds each manager's summary of the top cards from the roles below them.",
    reads=("insight_card", "outcome"), writes=("role_summary",), on_error="log",
    failure="Logged. The run still finishes.",
)  # fmt: skip
FINISH = Step(
    "finish_run", "Close the run",
    "Marks roles that never ran as failed, then sets the run to ok, partial or failed.",
    reads=("run_step",), writes=("run",), on_error="log",
    failure="Logged. The health check fails a run that stays open too long.",
)  # fmt: skip
DAILY_PLAN = Step(
    "daily_plan", "Plan today's roles",
    "Picks the roles to run today: daily-cadence roles and roles whose daily check crossed its alert level.",
    reads=("role_metric", "role_node", "metric_snapshot"), writes=("run_step",),
    on_error="fail_run", skips="Nobody needs a run today: the run closes with no roles.", failure="The run is marked failed.",
)  # fmt: skip
MEASURE = Step(
    "outcomes_measure", "Measure outcomes",
    "Measures initiatives against their baseline at the midpoint and the end.",
    reads=("initiative", "insight_card", "metric", "outcome"), writes=("outcome", "run_step"),
    timeout_s=900, on_error="fail_run", failure="The run is marked failed.",
)  # fmt: skip
DIGEST = Step(
    "digest_send", "Send the digest",
    "Emails each person their new cards and the value captured.",
    reads=("insight_card", "outcome", "initiative", "person", "role_assignment"), writes=("audit_log",),
    on_error="log", failure="Logged. The same slot can be sent again safely.",
)  # fmt: skip
ALL_TENANTS = Step(
    "all_tenants", "List workspaces", "Every workspace, or only the one that just got feedback.",
    reads=("tenant",),
)  # fmt: skip
COMPILE = Step(
    "feedback_compile", "Compile feedback",
    "Turns repeated feedback into proposed rules for our team to review. It never changes a rule.",
    reads=("feedback", "insight_card", "metric"), writes=("feedback_rule",),
    on_error="log", failure="Logged. The nightly run tries again.",
)  # fmt: skip
HEALTH = Step(
    "health_check", "Check health",
    "Fails runs left open for hours, counts failures, checks warehouse credit use and logins, purges old AI logs.",
    reads=("run", "warehouse_connection", "tenant"), writes=("run", "llm_call_log"),
    timeout_s=300, on_error="log", failure="Logged.",
)  # fmt: skip

# ---- the flows ----------------------------------------------------------------------------------

WEEKLY = Flow(
    "weekly", "Weekly run",
    "Every Monday morning (each workspace's own time zone): measure everything, find signals, write the week's cards.",
    Schedule(0, note="Due Monday 05:00 in the workspace's time zone"),
    (DUE, CREATE_RUN, METRICS, SIGNALS, PROMPT, LLM, INGEST, ROLLUP, FINISH),
    run_type="weekly", also="Run now from a workspace",
)  # fmt: skip
DAILY = Flow(
    "daily_check", "Daily check",
    "Every other morning: re-measure the metrics with a daily check and write cards only for roles that need one.",
    Schedule(5, note="Due 05:00 in the workspace's time zone, except Monday"),
    (DUE, CREATE_RUN, METRICS, DAILY_PLAN, SIGNALS, PROMPT, LLM, INGEST, ROLLUP, FINISH),
    run_type="daily_check",
)  # fmt: skip
REMEASURE = Flow(
    "remeasure", "Outcome measurement",
    "Every morning: measure what each action card achieved, against its baseline.",
    Schedule(30, note="Due 06:00 in the workspace's time zone"),
    (DUE, CREATE_RUN, MEASURE, ROLLUP, FINISH),
    run_type="remeasure",
)  # fmt: skip
DIGEST_FLOW = Flow(
    "digest", "Weekly digest",
    "Every Monday: each person gets an email with their new cards and the value captured.",
    Schedule(45, note="Due Monday 08:00 in the workspace's time zone"),
    (DUE, DIGEST),
)  # fmt: skip
FEEDBACK = Flow(
    "feedback", "Feedback compiler",
    "Turns what owners say (Action, Not relevant, Impossible) into proposed rules for review.",
    Schedule(0, hour=2),
    (ALL_TENANTS, COMPILE),
    window=timedelta(hours=3), also="Right after someone gives feedback",
)  # fmt: skip
HEALTH_FLOW = Flow(
    "health", "Health check",
    "Every hour: close stuck runs, count failures, watch warehouse credit use.",
    Schedule(15),
    (HEALTH,),
)  # fmt: skip

FLOWS: dict[str, Flow] = {
    f.key: f for f in (WEEKLY, DAILY, REMEASURE, DIGEST_FLOW, FEEDBACK, HEALTH_FLOW)
}
STEPS: dict[str, Step] = {s.key: s for f in FLOWS.values() for s in f.steps}
RUN_FLOWS = tuple(k for k, f in FLOWS.items() if f.run_type)


def tables_of(flow: Flow) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """Every table a flow reads and every table it writes, each once, in order of first use."""
    reads: dict[str, None] = {}
    writes: dict[str, None] = {}
    for s in flow.steps:
        reads.update(dict.fromkeys(s.reads))
        writes.update(dict.fromkeys(s.writes))
    return tuple(reads), tuple(writes)


# ---- when a flow is due -------------------------------------------------------------------------


def last_slot(schedule: Schedule, now: datetime) -> datetime:
    """The most recent moment on this schedule that is not after `now` (UTC)."""
    now = now.astimezone(UTC)
    if schedule.hour is None:
        slot = now.replace(minute=schedule.minute, second=0, microsecond=0)
        return slot if slot <= now else slot - timedelta(hours=1)
    slot = now.replace(hour=schedule.hour, minute=schedule.minute, second=0, microsecond=0)
    return slot if slot <= now else slot - timedelta(days=1)


def next_slot(schedule: Schedule, now: datetime) -> datetime:
    return last_slot(schedule, now) + (
        timedelta(hours=1) if schedule.hour is None else timedelta(days=1)
    )


def slot_to_fire(flow: Flow, now: datetime, fired: datetime | None) -> datetime | None:
    """The slot to start now, or None. A tick that was missed (the app was restarting) still fires
    within the flow's window; each slot fires once."""
    if flow.schedule is None:
        return None
    slot = last_slot(flow.schedule, now)
    if now - slot > flow.window:
        return None
    if fired is not None and fired >= slot:
        return None
    return slot


# ---- what a run of a flow records ---------------------------------------------------------------


@dataclass
class Execution:
    """One start of a flow, for the dashboard. Kept in memory; runs are also in the database."""

    flow: str
    trigger: Trigger
    started_at: datetime
    ended_at: datetime | None = None
    status: str = "running"  # running, ok, partial, failed or skipped
    workspaces: int = 0
    note: str = ""
    problems: list[str] = field(default_factory=list)


# ---- keys that make a repeat harmless (ADR 0004; the same forms n8n sent) -----------------------
# A scheduled start uses the token "scheduled", so the same slot twice is one run. A manual start
# uses its own execution id, so it always runs.

SCHEDULED = "scheduled"


def key_run(tenant_id: object, run_type: str, slot_iso: str, token: str) -> str:
    return f"{tenant_id}:{run_type}:{slot_iso}:{token}:create_run"


def key_role(run_id: object, role_id: object, step: str) -> str:
    return f"{run_id}:{role_id}:{step}"


def key_tenant(run_id: object, step: str) -> str:
    return f"{run_id}:tenant:{step}"


def key_digest(tenant_id: object, slot_iso: str, token: str) -> str:
    return f"{tenant_id}:digest:{slot_iso}:{token}"


def key_feedback(tenant_id: object, token: str) -> str:
    """`token` is the feedback id when someone just gave feedback, else the date and execution."""
    return f"{tenant_id}:feedback_compile:{token}"


# ---- what a node shows while a run is going (for the monitor) -----------------------------------

ROLE_STATUSES = ("ok", "skipped", "failed", "running")


def node_state(statuses: list[str], expected: int, run_running: bool) -> dict[str, int | str]:
    """What one step shows for one run, from the status of each of its rows.

    A workspace-level step has one row (`expected` 1); a role step has one row per role (`expected`
    is how many roles the run covers). States: `waiting` (not started, the run is going), `none`
    (never reached, the run is over), `running` (a row is being worked on right now), `progress`
    (some roles are through, the rest have not started yet), `ok`, `skipped` (all rows skipped),
    `partial` (some roles failed, some did not) and `failed`."""
    counts = {s: statuses.count(s) for s in ROLE_STATUSES}
    done = counts["ok"] + counts["skipped"] + counts["failed"]
    total = max(expected, len(statuses))
    if not statuses:
        state = "waiting" if run_running else "none"
    elif counts["running"]:
        state = "running"
    elif run_running and done < total:
        state = "progress"
    elif counts["failed"] and done == counts["failed"]:
        state = "failed"
    elif counts["failed"]:
        state = "partial"
    elif counts["ok"]:
        state = "ok"
    else:
        state = "skipped"
    return {"state": state, "done": done, "total": total, **counts}


def run_nodes(
    flow: Flow, run_status: str, rows: list[tuple[str | None, str, str]], roles_expected: int
) -> dict[str, dict[str, int | str]]:
    """Every step of a run-flow with its state. `rows` are (role id or None, step key, status) as
    recorded. The steps that leave no row of their own are read from the run: finding the workspace
    and opening the run happened if the run exists; closing it happened once the run is over."""
    running = run_status == "running"
    nodes: dict[str, dict[str, int | str]] = {}
    for step in flow.steps:
        if step.key in ("due_tenants", "create_run"):
            nodes[step.key] = node_state(["ok"], 1, running)
        elif step.key == "finish_run":
            end = "failed" if run_status == "failed" else "ok"
            nodes[step.key] = node_state([] if running else [end], 1, running)
            if run_status == "partial":
                nodes[step.key]["state"] = "partial"
        else:
            mine = [status for _, key, status in rows if key == step.key]
            nodes[step.key] = node_state(
                mine, roles_expected if step.scope == "role" else 1, running
            )
    return nodes
