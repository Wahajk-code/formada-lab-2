"""Control totals: a number the client already trusts, compared with what we compute.

A control total is one figure the client gives us at onboarding ("net sales, week ending
2026-11-15, were 412,300") together with how close we must be. On every run we find our own value
for the same metric, week and entity and compare. If they differ by more than the tolerance, our
numbers are not yet to be trusted for that metric and the team sees it before any card is blamed.

Pure: no I/O. `services/validation.py` reads the snapshots and stores the checks.

Words: *expected* is the client's figure; *ours* is what the metric snapshot holds; *drift* is how
far apart they are, as a percentage of the expected figure.
"""

from dataclasses import dataclass
from datetime import date
from typing import Any

MATCH, OFF, MISSING = "match", "off", "missing"

RECONCILED, DRIFT, UNCHECKED = "reconciled", "drift", "unchecked"


@dataclass(frozen=True)
class Check:
    status: str  # match | off | missing
    expected: float
    ours: float | None
    diff: float | None  # ours - expected
    diff_pct: float | None  # diff as a % of expected (None when expected is 0)


def _week(value: Any) -> date | None:
    if isinstance(value, date):
        return value
    try:
        return date.fromisoformat(str(value)[:10])
    except ValueError:
        return None


def our_value(
    series: dict[str, list[dict[str, Any]]], entity: str | None, week: date | None
) -> float | None:
    """The value of a metric snapshot that a control total talks about.

    `series` is `{entity: [{week, value}, ...]}` as stored on a snapshot. With an entity, that
    entity's point; without one, the sum over every entity (right for additive figures such as sales
    or units; a ratio must name its entity). With no week, the latest point of each entity. None
    when the snapshot holds no such point, which is a gap in our data, never a zero."""
    chosen = [entity] if entity else list(series)
    found: list[float] = []
    for name in chosen:
        points = series.get(name) or []
        if week is None:
            dated: list[tuple[date, float]] = []
            for p in points:
                d = _week(p.get("week"))
                if d is not None and p.get("value") is not None:
                    dated.append((d, float(p["value"])))
            if dated:
                found.append(max(dated, key=lambda dv: dv[0])[1])
            continue
        for p in points:
            if _week(p.get("week")) == week and p.get("value") is not None:
                found.append(float(p["value"]))
                break
    return sum(found) if found else None


def compare(expected: float, ours: float | None, tolerance_pct: float) -> Check:
    if ours is None:
        return Check(MISSING, expected, None, None, None)
    diff = ours - expected
    if expected == 0:
        return Check(MATCH if abs(diff) < 1e-9 else OFF, expected, ours, diff, None)
    pct = diff / abs(expected) * 100
    return Check(MATCH if abs(pct) <= tolerance_pct else OFF, expected, ours, diff, pct)


def say(name: str, check: Check, tolerance_pct: float) -> str:
    """One plain line about a check, for the console."""
    if check.status == MISSING:
        return f"{name}: we hold no number for it, so it cannot be checked."
    if check.status == MATCH:
        return f"{name}: our number matches the client's within {tolerance_pct:g}%."
    if check.diff_pct is None:
        return f"{name}: the client says 0 and we have {check.ours:g}."
    side = "higher" if check.diff_pct > 0 else "lower"
    return (
        f"{name}: ours is {abs(check.diff_pct):.1f}% {side} than the client's "
        f"(allowed {tolerance_pct:g}%)."
    )


def summarize(checks: list[Check]) -> dict[str, Any]:
    """How a workspace stands against all its control totals."""
    if not checks:
        return {"verdict": UNCHECKED, "total": 0, "matched": 0, "off": 0, "missing": 0,
                "worst_pct": None}  # fmt: skip
    matched = sum(1 for c in checks if c.status == MATCH)
    off = sum(1 for c in checks if c.status == OFF)
    missing = sum(1 for c in checks if c.status == MISSING)
    gaps = [abs(c.diff_pct) for c in checks if c.diff_pct is not None]
    return {
        "verdict": RECONCILED if matched == len(checks) else DRIFT,
        "total": len(checks),
        "matched": matched,
        "off": off,
        "missing": missing,
        "worst_pct": round(max(gaps), 2) if gaps else None,
    }
