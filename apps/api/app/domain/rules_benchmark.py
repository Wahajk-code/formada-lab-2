"""A benchmark for the Rules step: obvious things the AI chose, checked by code.

The rules advisor may override the engine's tunable numbers for one workspace. Code can tell, with
no AI and no warehouse, whether it read what it was given: it used only the settings it was offered,
stayed in range and under six changes, changed something that is really different, tied each reason
to a fact of the data, named what each change may cost, and left the settings agreeing with each
other (a window cannot be longer than the history it reads, a measure cannot need more weeks than
the data has, and rows needed above the row cap must be noticed).

Pure. Probes have the same shape as the other benchmarks'.
"""

import re
from typing import Any

from app.domain.config import SCHEMA, coerce
from app.domain.discovery_benchmark import _probe, grade

BLOCKED_GROUPS = {"access"}
BLOCKED_KEYS = {"llm_log_retention_days"}
MAX_CHANGES = 6
# A reason that points at the data says something about weeks, rows, entities, cadence or quality.
FACT = re.compile(
    r"(\d|week|row|history|entit|cadence|daily|weekly|row cap|quality|noise|zero|sparse|truncat)",
    re.IGNORECASE,
)
# Pairs of settings that must agree: (smaller, larger, why).
ORDER = (
    (
        "recent_exceed_min",
        "recent_weeks",
        "weeks that must exceed cannot outnumber the recent weeks",
    ),
    (
        "min_baseline_points",
        "trailing_weeks",
        "baseline points cannot outnumber the baseline weeks",
    ),
    ("recent_weeks", "trailing_weeks", "the recent window must be shorter than the baseline"),
    ("min_window_days", "max_window_days", "the shortest outcome window cannot exceed the longest"),
)
CRITICAL = {"keys_offered", "nothing_blocked", "in_range", "settings_agree", "history_fits"}


def _effective(offered: dict[str, Any], changes: list[dict[str, Any]]) -> dict[str, float]:
    values = {str(s["key"]): float(s["value"]) for s in offered.get("settings", [])}
    for c in changes:
        try:
            values[str(c["key"])] = float(coerce(str(c["key"]), c["value"]))
        except (ValueError, KeyError, TypeError):
            continue
    return values


def run(out: dict[str, Any], offered: dict[str, Any] | None) -> dict[str, Any] | None:
    """The benchmark of one rules answer, or None when there is nothing to check it against."""
    changes = list(out.get("changes") or [])
    kept = list(out.get("kept") or [])
    if not offered or not offered.get("settings") or not (changes or kept):
        return None
    given = {str(s["key"]): s for s in offered["settings"]}
    probes: list[dict[str, str]] = []

    named = [str(c["key"]) for c in changes] + [str(k["key"]) for k in kept]
    foreign = sorted({k for k in named if k not in given})
    probes.append(
        _probe(
            "keys_offered",
            "Picks",
            "Only settings it was given",
            "every setting named was offered to it",
            "all offered" if not foreign else "not offered: " + ", ".join(foreign[:4]),
            "pass" if not foreign else "fail",
        )
    )

    blocked = [
        str(c["key"])
        for c in changes
        if str(c["key"]) in SCHEMA
        and (SCHEMA[str(c["key"])].group in BLOCKED_GROUPS or str(c["key"]) in BLOCKED_KEYS)
    ]
    probes.append(
        _probe(
            "nothing_blocked",
            "Picks",
            "No access, password or retention setting changed",
            "those settings are never changed by onboarding",
            "none touched" if not blocked else "changed: " + ", ".join(blocked[:4]),
            "pass" if not blocked else "fail",
        )
    )

    outside = []
    for c in changes:
        try:
            coerce(str(c["key"]), c["value"])
        except (ValueError, KeyError, TypeError):
            outside.append(f"{c.get('key')} = {c.get('value')}")
    probes.append(
        _probe(
            "in_range",
            "Picks",
            "Every new value is inside its allowed range",
            "a value the setting accepts",
            "all inside" if not outside else "outside: " + ", ".join(outside[:3]),
            "pass" if not outside else "fail",
        )
    )

    probes.append(
        _probe(
            "restraint",
            "Choices",
            f"At most {MAX_CHANGES} changes",
            "the smallest change that works",
            f"{len(changes)} changes",
            "pass" if len(changes) <= MAX_CHANGES else "fail",
        )
    )

    same = [
        str(c["key"])
        for c in changes
        if str(c["key"]) in given
        and abs(float(given[str(c["key"])]["value"]) - float(c["value"])) < 1e-9
    ]
    twice = sorted({k for k in named if named.count(k) > 1})
    probes.append(
        _probe(
            "real_changes",
            "Choices",
            "Every change is really different, nothing listed twice",
            "a new value, and no setting both changed and kept",
            "clean"
            if not (same or twice)
            else "; ".join(
                [
                    *(f"{k} is already that value" for k in same[:2]),
                    *(f"{k} is listed twice" for k in twice[:2]),
                ]
            ),
            "pass" if not (same or twice) else "fail",
        )
    )

    hollow = [str(c["key"]) for c in changes if not FACT.search(str(c.get("reason", "")))]
    probes.append(
        _probe(
            "reasons_have_facts",
            "Reasons",
            "Each change points at a fact of the data",
            "a reason that names a number, weeks, rows or the data's rhythm",
            "all do" if not hollow else "no fact in the reason for: " + ", ".join(hollow[:3]),
            "pass" if not hollow else "fail",
        )
    )

    if changes:
        probes.append(
            _probe(
                "costs_named",
                "Reasons",
                "What the changes may cost is named",
                "at least one risk listed",
                f"{len(out.get('risks') or [])} risks",
                "pass" if out.get("risks") else "fail",
            )
        )
    thin = [str(k["key"]) for k in kept if len(str(k.get("why", "")).split()) < 3]
    if kept:
        probes.append(
            _probe(
                "kept_explained",
                "Reasons",
                "Settings left alone are explained",
                "a reason for each",
                "all explained" if not thin else "no reason for: " + ", ".join(thin[:3]),
                "pass" if not thin else "fail",
            )
        )

    eff = _effective(offered, changes)
    broken = [
        f"{a} ({eff[a]:g}) against {b} ({eff[b]:g}): {why}"
        for a, b, why in ORDER
        if a in eff and b in eff and (eff[a] > eff[b] if a != "recent_weeks" else eff[a] >= eff[b])
    ]
    probes.append(
        _probe(
            "settings_agree",
            "Numbers",
            "The settings still agree with each other",
            "windows and minimums that fit together",
            "all agree" if not broken else "; ".join(broken[:2]),
            "pass" if not broken else "fail",
        )
    )

    plan = offered.get("metric_plan") or []
    weeks = {
        str(m["key"]): float((m.get("dry_run") or {}).get("weeks", 0))
        for m in plan
        if isinstance(m.get("dry_run"), dict) and (m["dry_run"] or {}).get("weeks")
    }
    need = eff.get("min_weeks_of_history")
    if weeks and need is not None:
        short = sorted(k for k, w in weeks.items() if w < need)
        probes.append(
            _probe(
                "history_fits",
                "Numbers",
                "No measure needs more history than the data has",
                f"every measure has at least {need:g} weeks",
                "all have enough"
                if not short
                else f"too short for {need:g} weeks: " + ", ".join(short[:3]),
                "pass" if not short else "fail",
            )
        )

    over = {
        str(m["key"]): int(m["dry_run"]["rows_needed_vs_workspace_cap"]["rows"])
        for m in plan
        if isinstance(m.get("dry_run"), dict)
        and not ((m["dry_run"].get("rows_needed_vs_workspace_cap") or {}).get("fits", True))
    }
    if over:
        cap = eff.get("query_row_cap", 0)
        noticed = cap >= max(over.values()) or any(str(k["key"]) == "query_row_cap" for k in kept)
        probes.append(
            _probe(
                "row_cap_noticed",
                "Numbers",
                "Measures that exceed the row cap are noticed",
                "the cap is raised, or kept on purpose with a reason",
                "noticed"
                if noticed
                else f"{', '.join(sorted(over)[:3])} need more rows than the cap of {cap:g}",
                "pass" if noticed else "fail",
            )
        )
    return grade(probes, CRITICAL)
