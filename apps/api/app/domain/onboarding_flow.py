"""Onboarding progress on both sides (ADR 0027, redesigned 2026-11-10 in ADR 0030). Pure.

Six steps, strictly in order: connect, discovery, mapping, org, metrics, trial.
- Formada completes connect, discovery, mapping and metrics on its own; the client follows them.
- The client builds and confirms the org chart; the team then applies it (org is done when the
  team approves it, which needs the client's confirmed chart).
- The trial is done when the client goes live, after a successful trial run.
Business rules are no longer a step: the team sets them inside metrics ("rules" stays an agent
that may run while metrics is open). Only the team can reopen a done step.

The client sees five steps: Connect data, Prepare data (discovery + mapping), Organization,
Metrics, Go live.
"""

from dataclasses import dataclass, field
from typing import Any

from app.domain import plain
from app.domain.config import DEFAULTS, RulesConfig

TEAM_STEPS = ("connect", "discovery", "mapping", "org", "metrics", "trial")
AGENT_STEPS = ("discovery", "mapping", "org", "metrics", "rules")
# The client's bar: its step key -> the team steps it covers.
CLIENT_STEPS: dict[str, tuple[str, ...]] = {
    "connect": ("connect",),
    "prepare": ("discovery", "mapping"),
    "org": ("org",),
    "metrics": ("metrics",),
    "live": ("trial",),
}
# Auxiliary agent steps worked on inside a main step.
INSIDE = {"rules": "metrics"}


@dataclass
class Signoff:
    team: bool = False
    client: bool = False


@dataclass
class Progress:
    signoffs: dict[str, Signoff]  # step -> approvals
    latest: dict[str, str]  # step -> status of its newest agent proposal
    open_threads: list[dict[str, str]] = field(default_factory=list)  # {step, waiting_on}
    draft_status: str | None = None  # org draft: draft | submitted | approved | None
    trial_ok: bool = False
    connected: bool = False
    live: bool = False
    lab: bool = False  # the review lab: every step can be worked on, in any order

    def sign(self, step: str) -> Signoff:
        return self.signoffs.get(step) or Signoff()

    def done(self, step: str) -> bool:
        if step == "trial":
            return self.live
        return self.sign(step).team


def current_step(p: Progress) -> str:
    """The first step not done (trial once everything is)."""
    return next((s for s in TEAM_STEPS if not p.done(s)), "trial")


def is_open(p: Progress, step: str) -> bool:
    """A step can be worked on only when every step before it is done (any order in the lab)."""
    if p.lab:
        return True
    step = INSIDE.get(step, step)
    i = TEAM_STEPS.index(step)
    return all(p.done(s) for s in TEAM_STEPS[:i])


def _waiting(p: Progress, step: str, side: str) -> int:
    return sum(1 for t in p.open_threads if t["step"] == step and t["waiting_on"] == side)


def team_step(p: Progress, step: str) -> dict[str, Any]:
    sign = p.sign(step)
    latest = p.latest.get(step)
    if p.done(step):
        status = "done"
    elif not is_open(p, step):
        status = "locked"
    elif step == "trial" and p.trial_ok:
        status = "waiting"  # the client reviews the trial and goes live
    elif latest == "running":
        status = "working"
    elif _waiting(p, step, "client") or (step == "org" and p.draft_status in (None, "draft")):
        status = "waiting"
    elif latest == "proposed":
        status = "review"
    elif latest == "failed":
        status = "failed"
    else:
        status = "todo"
    return {
        "key": step,
        "status": status,
        "team_approved": sign.team,
        # The client's own part: confirming the org chart, going live after the trial.
        "client_approved": (step == "org" and p.draft_status in ("submitted", "approved"))
        or (step == "trial" and p.live),
        "questions_for_team": _waiting(p, step, "team"),
        "questions_for_client": _waiting(p, step, "client"),
    }


def team_steps(p: Progress) -> list[dict[str, Any]]:
    return [team_step(p, s) for s in TEAM_STEPS]


def client_step(p: Progress, key: str) -> dict[str, Any]:
    """One step of the client's bar. Statuses: done, upcoming, your_input, waiting_on_you,
    with_formada. The client opens done steps and the current one."""
    covers = CLIENT_STEPS[key]
    questions = sum(_waiting(p, s, "client") for s in covers)
    if all(p.done(s) for s in covers):
        status = "done"
    elif not is_open(p, covers[0]):
        status = "upcoming"
    elif (key == "org" and p.draft_status in (None, "draft")) or (key == "live" and p.trial_ok):
        status = "your_input"
    elif questions:
        status = "waiting_on_you"
    else:
        status = "with_formada"
    return {
        "key": key,
        "steps": list(covers),
        "status": status,
        "can_open": status != "upcoming",
        "questions_for_you": questions,
        "questions_for_team": sum(_waiting(p, s, "team") for s in covers),
    }


def client_steps(p: Progress) -> list[dict[str, Any]]:
    return [client_step(p, k) for k in CLIENT_STEPS]


def client_current(p: Progress) -> str:
    """The client's step that holds the team's current step."""
    cur = current_step(p)
    return next(k for k, covers in CLIENT_STEPS.items() if cur in covers)


def percent(p: Progress) -> int:
    if p.live:
        return 100
    return round(100 * sum(1 for s in TEAM_STEPS if p.done(s)) / len(TEAM_STEPS))


def team_approve_error(p: Progress, step: str) -> str | None:
    """Why the team cannot complete (approve) this step now, or None."""
    if not is_open(p, step):
        return "finish the earlier steps first"
    if step == "trial":
        return "the client goes live from their trial step"
    if step != "rules" and p.sign(step).team:
        return "already complete; reopen it to change it"
    if step == "rules" and p.done("metrics"):
        return "metrics are published; reopen metrics to change the rules"
    if step == "connect" and not p.connected:
        return "test the connection first"
    if step == "org" and p.draft_status in (None, "draft"):
        return "the client has not confirmed their org chart yet"
    return None


def team_work_error(p: Progress, step: str) -> str | None:
    """Why the team cannot propose or edit this step now, or None."""
    if not is_open(p, step):
        return "finish the earlier steps first"
    if p.done(INSIDE.get(step, step)):
        return "this step is complete; reopen it to edit it"
    return None


def go_live_error(p: Progress) -> str | None:
    """Why the client cannot go live now, or None."""
    blockers = go_live_blockers(p)
    return blockers[0] if blockers else None


def go_live_blockers(p: Progress) -> list[str]:
    if p.live:
        return ["the workspace is already live"]
    blockers = [f"{s}: not complete yet" for s in TEAM_STEPS[:-1] if not p.done(s)]
    if not p.trial_ok:
        blockers.append("run a successful trial first")
    return blockers


# ---------------------------------------------------------------------------------------------
# Client-safe summaries, written when the team approves a step. Plain words, no SQL, no agent
# inputs, no checks. Amounts are the client's own data, so they may appear.
# ---------------------------------------------------------------------------------------------

ARCHETYPE_WORDS = {
    "inventory_snapshot": "Stock by item and location, per day",
    "inventory_position": "Current stock per item",
    "sales_line": "Sales lines",
    "purchase_order": "Purchase orders",
    "purchase_order_line": "Purchase order lines",
    "wholesale_order_line": "Wholesale order lines",
}


def summary_connect(database: str, schemas: list[str], tested_at: str | None) -> dict[str, Any]:
    return {"database": database, "schemas": schemas, "tested_at": tested_at}


def summary_discovery(out: dict[str, Any], profile: dict[str, Any] | None = None) -> dict[str, Any]:
    cov = out.get("coverage", [])
    base = {
        "summary": out.get("summary", ""),
        "found": [c["family"] for c in cov if c["status"] == "present"],
        "partial": [c["family"] for c in cov if c["status"] == "partial"],
        "missing": [c["family"] for c in cov if c["status"] == "missing"],
        "issues": [
            {"title": q["title"], "severity": q["severity"], "handling": q["suggested_handling"],
             "plain": plain.plain_or_none(q["suggested_handling"])}
            for q in out.get("quality_issues", [])
        ],
    }  # fmt: skip
    return {
        **base,
        "facts": plain.data_facts(profile or {}),
        "levels": plain.coverage_levels(cov),
        "checked": plain.checked_counts(base),
    }


def summary_mapping(
    out: dict[str, Any], checks: dict[str, Any], written: list[str],
    locations: dict[str, list[str]] | None = None,
) -> dict[str, Any]:  # fmt: skip
    by = {a["archetype"]: a for a in out.get("archetypes", [])}
    return {
        "datasets": [
            {
                "name": ARCHETYPE_WORDS.get(k, k.replace("_", " ").capitalize()),
                "rows": checks.get(k, {}).get("rows"),
                "first_date": checks.get(k, {}).get("first_date"),
                "last_date": checks.get(k, {}).get("last_date"),
                "rules": by.get(k, {}).get("filters", []),
                "rules_plain": [
                    x
                    for x in (plain.plain_or_none(f) for f in by.get(k, {}).get("filters", []))
                    if x
                ],
            }
            for k in written
        ],
        # Location kind -> the client's own location names (counted, for the one question).
        "locations": {
            kind: {"count": len(names), "names": names[:8]}
            for kind, names in (locations or {}).items()
        },
        "not_available": [
            ARCHETYPE_WORDS.get(a["archetype"], a["archetype"])
            for a in out.get("archetypes", [])
            if a["status"] == "unmappable"
        ],
    }


def summary_org(out: dict[str, Any], draft: list[dict[str, Any]] | None) -> dict[str, Any]:
    titles = {r["ref"]: r["title"] for r in out.get("roles", [])}
    return {
        "roles": [
            {
                "title": r["title"],
                "reports_to": titles.get(r.get("parent_ref") or "", ""),
                "department": r.get("department") or "",
                "why": r.get("why", ""),
            }
            for r in out.get("roles", [])
        ],
        "left_out": [n["title"] for n in (draft or []) if n["id"] not in titles],
        "departments": [d["name"] for d in out.get("departments", [])],
    }


def _alert(a: dict[str, Any]) -> float | str:
    """The alert level as a number (the app formats it), or "trend"."""
    if a["threshold"]["kind"] == "none" or a.get("threshold_value") is None:
        return "trend"
    return float(a["threshold_value"])


def summary_metrics(
    out: dict[str, Any], role_titles: dict[str, str], currency: str
) -> dict[str, Any]:
    return {
        "currency": currency,
        "measures": [
            {
                "name": m["name"],
                "unit": m["unit"],
                "better": "higher" if m["higher_is_better"] else "lower",
                "for": [
                    {"role": role_titles.get(a["role_ref"], a["role_ref"]),
                     "alert_at": _alert(a), "daily": a["daily_check"],
                     "would_fire": a.get("would_fire")}
                    for a in m["attach"]
                ],
            }
            for m in out.get("metrics", [])
        ],
    }  # fmt: skip


def summary_rules(
    changes: list[dict[str, Any]], labels: dict[str, tuple[str, str]],
    effective: RulesConfig | None = None, currency: str = "CAD",
) -> dict[str, Any]:  # fmt: skip
    """labels: key -> (label, unit). effective: the workspace's rules once these are applied."""
    rules = effective or DEFAULTS
    return {
        "floor": rules.min_signal_impact,
        "cards_per_person": rules.max_open_cards_per_role,
        "preset": plain.preset_of(rules),
        "nearest": plain.nearest_preset(rules),
        "currency": currency,
        "changes": [
            {"key": c["key"], "label": labels.get(c["key"], (c["key"], ""))[0],
             "value": c["clean_value"],
             "unit": labels.get(c["key"], ("", ""))[1], "reason": c.get("reason", "")}
            for c in changes
            if c.get("clean_value") is not None
        ]
    }  # fmt: skip


def summary_trial(
    status: str, at: str, cards: list[dict[str, Any]], currency: str = "CAD"
) -> dict[str, Any]:
    """cards: title, role and (estimated) impact, strongest first."""
    return {
        "status": status,
        "at": at,
        "cards": len(cards),
        "people": len({c["role"] for c in cards}),
        "at_stake": round(sum(float(c.get("impact") or 0) for c in cards), 2),
        "currency": currency,
        "examples": [{"title": c["title"], "role": c["role"]} for c in cards[:5]],
    }
