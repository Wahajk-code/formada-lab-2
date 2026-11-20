"""Signal filtering and ranking per role (spec: Pipeline step 3)."""

from dataclasses import dataclass

from app.domain.config import RulesConfig
from app.domain.detection import SignalDraft


@dataclass(frozen=True)
class RoleFeedbackState:
    suppressed_fingerprints: frozenset[str]  # Not relevant in the window, or forbid rules
    downweighted_metrics: frozenset[str]  # metric keys with an active downweight rule
    open_fingerprints: frozenset[str]  # already an open card for this role


@dataclass(frozen=True)
class Decision:
    signal: SignalDraft
    status: str  # selected | suppressed | dropped
    reason: str | None
    score: float


def select_signals(
    signals: list[SignalDraft],
    weights: dict[str, float],
    state: RoleFeedbackState,
    rules: RulesConfig,
) -> list[Decision]:
    """Suppress, score (impact x weight x downweight), keep the top N; report every decision."""
    decisions: list[Decision] = []
    candidates: list[Decision] = []
    for s in signals:
        weight = weights.get(s.metric_key, 1.0)
        if s.metric_key in state.downweighted_metrics:
            weight *= rules.downweight_factor
        score = s.est_impact * weight
        if s.fingerprint in state.suppressed_fingerprints:
            decisions.append(Decision(s, "suppressed", "feedback suppression", score))
        elif s.fingerprint in state.open_fingerprints:
            decisions.append(Decision(s, "suppressed", "open card exists", score))
        else:
            candidates.append(Decision(s, "selected", None, score))
    candidates.sort(key=lambda d: d.score, reverse=True)
    keep = rules.top_signals_per_role
    # Room for every measure first: a small but real problem (backorders at three stores) must
    # not lose to big stock numbers just because money ranks it lower.
    chosen: list[Decision] = []
    per_metric: dict[str, int] = {}
    for d in candidates:
        n = per_metric.get(d.signal.metric_key, 0)
        if n < rules.min_signals_per_metric and len(chosen) < keep:
            chosen.append(d)
            per_metric[d.signal.metric_key] = n + 1
    taken = {id(d) for d in chosen}
    chosen += [d for d in candidates if id(d) not in taken][: max(0, keep - len(chosen))]
    chosen.sort(key=lambda d: d.score, reverse=True)
    kept = {id(d) for d in chosen}
    decisions += chosen
    decisions += [
        Decision(d.signal, "dropped", "below top N", d.score)
        for d in candidates
        if id(d) not in kept
    ]
    return decisions
