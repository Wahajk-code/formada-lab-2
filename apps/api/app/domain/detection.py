"""Deterministic signal detection on weekly metric series (spec: Pipeline step 2).

Per entity: week-over-week change, z-score of the recent level against the trailing window
(13 weeks before it), and threshold breach. Trend kinds only fire on adverse moves (a cost going
up, a revenue going down); a threshold breach fires on its own. Signals below the materiality
floor are dropped. One signal per entity: the strongest kind wins.

The z-score tests the mean of the last `recent_weeks` observations against the trailing window,
with the standard error, and needs most recent points to exceed baseline + 1 sd (ADR 0014). This
catches sustained drift that a single-point z-score misses once the drift enters its own window,
and ignores one-off spikes such as a single late container.
"""

import math
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from app.domain.config import RulesConfig

KIND_RANK = {"threshold": 3, "zscore": 2, "wow_change": 1}


@dataclass(frozen=True)
class Point:
    period_start: date
    value: float
    n: int | None = None


@dataclass(frozen=True)
class MetricInfo:
    key: str
    name: str
    unit: str
    higher_is_better: bool
    unit_value: float
    currency: str
    threshold: float | None = None


@dataclass
class SignalDraft:
    metric_key: str
    kind: str
    entity: str
    direction: str
    value: float
    baseline: float
    zscore: float | None
    change_pct: float | None
    est_impact: float
    impact_unit: str
    evidence: dict[str, Any] = field(default_factory=dict)

    @property
    def fingerprint(self) -> str:
        return f"{self.metric_key}:{self.entity}:{self.direction}"


def _mean_std(values: list[float]) -> tuple[float, float]:
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / (len(values) - 1) if len(values) > 1 else 0.0
    return mean, math.sqrt(var)


def week_over_week(current: float, previous: float) -> float | None:
    if previous == 0:
        return None
    return (current - previous) / abs(previous) * 100


def zscore(current: float, trailing: list[float]) -> float | None:
    if len(trailing) < 2:
        return None
    mean, std = _mean_std(trailing)
    if std == 0:
        return None
    return (current - mean) / std


def is_adverse(delta: float, higher_is_better: bool) -> bool:
    return delta < 0 if higher_is_better else delta > 0


def breaches(value: float, threshold: float | None, higher_is_better: bool) -> bool:
    if threshold is None:
        return False
    return value < threshold if higher_is_better else value > threshold


def detect_entity(
    metric: MetricInfo,
    entity: str,
    series: list[Point],
    exposure: float,
    drivers: dict[str, Any],
    rules: RulesConfig,
) -> SignalDraft | None:
    points = sorted(series, key=lambda p: p.period_start)
    if len(points) < rules.min_weeks_of_history:
        return None
    current, previous = points[-1], points[-2]
    recent = points[-rules.recent_weeks :]
    level_start = recent[0].period_start.toordinal()
    window_start = level_start - 7 * rules.trailing_weeks
    trailing = [p.value for p in points if window_start <= p.period_start.toordinal() < level_start]
    if len(trailing) < rules.min_baseline_points:
        return None
    baseline, std = _mean_std(trailing)
    recent_mean = sum(p.value for p in recent) / len(recent)
    delta = recent_mean - baseline
    adverse = is_adverse(delta, metric.higher_is_better)

    # Level shift: z of the recent mean (standard error), confirmed by most recent points.
    level_z = delta / (std / math.sqrt(len(recent))) if std > 0 else None
    sign = 1 if delta > 0 else -1
    exceeding = sum(1 for p in recent if sign * (p.value - baseline) > std)
    point_z = zscore(current.value, trailing)
    wow = week_over_week(current.value, previous.value)

    kinds: list[str] = []
    # A threshold is a standing condition: it fires whatever the trend (e.g. overstock that is
    # slowly improving is still overstock). The z-score and week-over-week kinds need an adverse
    # move, and week-over-week also a level move of at least 1 sd (filters cadence noise).
    if breaches(current.value, metric.threshold, metric.higher_is_better):
        kinds.append("threshold")
    if (
        adverse
        and level_z is not None
        and abs(level_z) > rules.zscore_threshold
        and exceeding >= rules.recent_exceed_min
    ):
        kinds.append("zscore")
    if (
        adverse
        and wow is not None
        and abs(wow) >= rules.wow_change_threshold_pct
        and is_adverse(current.value - previous.value, metric.higher_is_better)
        and level_z is not None
        and abs(level_z) >= rules.wow_min_level_z
    ):
        kinds.append("wow_change")
    if not kinds:
        return None
    kind = max(kinds, key=KIND_RANK.__getitem__)

    # Size of the problem: excess over the threshold for a breach, else the move vs baseline.
    gap = current.value - metric.threshold if kind == "threshold" and metric.threshold else delta
    impact = round(abs(gap) * metric.unit_value * max(exposure, 1.0), 2)
    if impact < rules.min_signal_impact:
        return None
    evidence = {
        "metric": metric.name,
        "metric_key": metric.key,
        "signal_kind": kind,
        "unit": metric.unit,
        "entity": entity,
        "current_week": current.period_start.isoformat(),
        "current_value": round(current.value, 2),
        "previous_value": round(previous.value, 2),
        "recent_mean": round(recent_mean, 2),
        "recent_weeks": len(recent),
        "baseline_mean": round(baseline, 2),
        "baseline_weeks": len(trailing),
        "change_vs_baseline": round(delta, 2),
        "change_vs_baseline_pct": round(delta / baseline * 100, 1) if baseline else None,
        "excess_over_threshold": round(gap, 2) if kind == "threshold" else None,
        "breach": ("below" if metric.higher_is_better else "above")
        if kind == "threshold"
        else None,
        "week_over_week_pct": round(wow, 1) if wow is not None else None,
        "zscore": round(level_z, 2) if level_z is not None else None,
        "point_zscore": round(point_z, 2) if point_z is not None else None,
        "threshold": metric.threshold,
        "estimated_impact": impact,
        "impact_unit": metric.currency,
        "exposure": exposure,  # frozen into an initiative when the card is actioned
        "series": [{"week": p.period_start.isoformat(), "value": p.value} for p in points[-14:]],
        "drivers": drivers,
    }
    return SignalDraft(
        metric_key=metric.key,
        kind=kind,
        entity=entity,
        direction="up" if gap > 0 else "down",
        value=recent_mean,
        baseline=baseline,
        zscore=level_z,
        change_pct=wow,
        est_impact=impact,
        impact_unit=metric.currency,
        evidence=evidence,
    )


def detect(
    metric: MetricInfo,
    series_by_entity: dict[str, list[Point]],
    drivers_by_entity: dict[str, dict[str, Any]],
    exposure_by_entity: dict[str, float],
    rules: RulesConfig,
) -> list[SignalDraft]:
    found = []
    for entity, series in series_by_entity.items():
        signal = detect_entity(
            metric,
            entity,
            series,
            exposure_by_entity.get(entity, 1.0),
            drivers_by_entity.get(entity, {}),
            rules,
        )
        if signal:
            found.append(signal)
    return sorted(found, key=lambda s: s.est_impact, reverse=True)
