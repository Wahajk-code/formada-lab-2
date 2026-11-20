"""Initiatives and outcome measurement (spec: Actioning and outcomes; ADR 0019).

An owner actions a card: the initiative's baseline is the level the card reported (the mean of
its recent weeks), measured again at the midpoint and the end of the window with the same
template and filters. value_captured = change vs baseline x unit_value x exposure, signed so that
improvement is positive. It is shown as change versus baseline, never as proven causation.
"""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.domain.config import RulesConfig


@dataclass(frozen=True)
class ActionDefaults:
    baseline_value: float
    baseline_period: str
    window_days: int
    exposure: float


@dataclass(frozen=True)
class Due:
    kind: str  # midpoint | end
    on: date


def clamp_window(days: int | None, rules: RulesConfig) -> int:
    if days is None:
        days = rules.min_window_days * 2
    return min(max(days, rules.min_window_days), rules.max_window_days)


def action_defaults(
    evidence: dict[str, Any], suggested_window_days: int | None, rules: RulesConfig
) -> ActionDefaults:
    """Prefill for the Action this form: the card's own numbers, editable by the owner."""
    value = evidence.get("recent_mean", evidence.get("current_value"))
    weeks = evidence.get("recent_weeks", rules.recent_weeks)
    period = f"{weeks} weeks to {evidence.get('current_week', '')}".strip()
    return ActionDefaults(
        baseline_value=float(value or 0),
        baseline_period=period,
        window_days=clamp_window(suggested_window_days, rules),
        exposure=float(evidence.get("exposure") or 1.0),
    )


def due_measurements(
    started: date, window_days: int, done: Iterable[str], today: date, rules: RulesConfig
) -> list[Due]:
    """Midpoint and end measurements that are due and not yet written."""
    taken = set(done)
    midpoint = started + timedelta(days=round(window_days * rules.outcome_midpoint_fraction))
    end = started + timedelta(days=window_days)
    return [
        Due(kind, on)
        for kind, on in (("midpoint", midpoint), ("end", end))
        if kind not in taken and on <= today
    ]


def level(values: list[float], recent_weeks: int) -> float | None:
    """Same statistic as the card: the mean of the most recent weeks."""
    recent = values[-recent_weeks:]
    return sum(recent) / len(recent) if recent else None


def captured(
    baseline: float, value: float, higher_is_better: bool, unit_value: float, exposure: float
) -> tuple[float, float]:
    """(delta_vs_baseline, value_captured). Positive value_captured means improvement."""
    delta = value - baseline
    improvement = delta if higher_is_better else -delta
    return round(delta, 4), round(improvement * unit_value * max(exposure, 1.0), 2)
