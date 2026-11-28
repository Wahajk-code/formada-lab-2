"""Backtesting signal detection on a client's own history.

Detection is plain code, so we can replay it: for every past week, hide everything after that week,
run the same `detect()` the weekly run uses, and note what would have fired. Two questions follow.

1. Noise: how often would we have raised a signal at all, and for how many weeks in a row? A metric
   that fires nearly every week is not telling the owner anything new.
2. Catches: when the client tells us about a real past incident (a stock-out, a bad month), did a
   signal for that entity fire in the weeks before it? And how early?

Pure: no I/O. `services/validation.py` feeds it the stored snapshot series.
"""

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

from app.domain.config import RulesConfig
from app.domain.detection import MetricInfo, Point, detect

WEEK = timedelta(days=7)


@dataclass(frozen=True)
class Incident:
    """Something the client says really happened: this entity had a problem in this week."""

    entity: str
    week: date
    note: str = ""


def replay(
    metric: MetricInfo,
    series_by_entity: dict[str, list[Point]],
    exposure_by_entity: dict[str, float],
    rules: RulesConfig,
) -> list[dict[str, Any]]:
    """What detection would have said at the end of each past week, oldest first.

    A week is replayed only when it is at least `min_weeks_of_history` deep. An entity with no
    point in that week is left out, so an old reading is never reported as new."""
    weeks = sorted({p.period_start for pts in series_by_entity.values() for p in pts})
    out: list[dict[str, Any]] = []
    for as_of in weeks[max(rules.min_weeks_of_history - 1, 0) :]:
        known = {
            e: [p for p in pts if p.period_start <= as_of] for e, pts in series_by_entity.items()
        }
        known = {e: pts for e, pts in known.items() if pts and pts[-1].period_start == as_of}
        found = detect(metric, known, {}, exposure_by_entity, rules)
        out.append(
            {
                "week": as_of.isoformat(),
                "signals": [
                    {
                        "entity": s.entity,
                        "kind": s.kind,
                        "direction": s.direction,
                        "impact": s.est_impact,
                    }
                    for s in found
                ],
            }
        )
    return out


def episodes(replayed: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Signals on the same entity and direction in consecutive weeks are one episode."""
    open_: dict[tuple[str, str], dict[str, Any]] = {}
    done: list[dict[str, Any]] = []
    previous: date | None = None
    for row in replayed:
        week = date.fromisoformat(row["week"])
        seen = {(s["entity"], s["direction"]) for s in row["signals"]}
        for key in list(open_):
            ended = key not in seen or (previous is not None and week - previous > WEEK)
            if ended:
                done.append(open_.pop(key))
        for s in row["signals"]:
            key = (s["entity"], s["direction"])
            ep = open_.setdefault(
                key,
                {"entity": key[0], "direction": key[1], "first_week": row["week"], "weeks": 0},
            )
            ep["weeks"] += 1
            ep["last_week"] = row["week"]
            ep["biggest_impact"] = max(ep.get("biggest_impact", 0.0), s["impact"])
        previous = week
    return done + list(open_.values())


def catches(
    replayed: list[dict[str, Any]], incidents: list[Incident], lead_weeks: int
) -> list[dict[str, Any]]:
    """For each incident: did a signal for its entity fire in the `lead_weeks` before it (or in the
    week itself), and how many weeks ahead was the first one?"""
    out = []
    for inc in incidents:
        window_start = inc.week - lead_weeks * WEEK
        hits = sorted(
            date.fromisoformat(r["week"])
            for r in replayed
            if window_start <= date.fromisoformat(r["week"]) <= inc.week
            and any(s["entity"] == inc.entity for s in r["signals"])
        )
        replayable = any(date.fromisoformat(r["week"]) <= inc.week for r in replayed)
        out.append(
            {
                "entity": inc.entity,
                "week": inc.week.isoformat(),
                "note": inc.note,
                "status": "caught" if hits else ("missed" if replayable else "too_early"),
                "lead_weeks": (inc.week - hits[0]).days // 7 if hits else None,
            }
        )
    return out


def summarize(
    replayed: list[dict[str, Any]],
    incidents: list[Incident],
    *,
    noisy_week_pct: float,
    lead_weeks: int,
    min_caught_pct: float,
) -> dict[str, Any]:
    weeks = len(replayed)
    with_signal = sum(1 for r in replayed if r["signals"])
    eps = episodes(replayed)
    noise_pct = round(with_signal / weeks * 100, 1) if weeks else 0.0
    caught = catches(replayed, incidents, lead_weeks)
    judged = [c for c in caught if c["status"] != "too_early"]
    caught_n = sum(1 for c in judged if c["status"] == "caught")
    caught_pct = round(caught_n / len(judged) * 100, 1) if judged else None

    if not weeks:
        verdict, why = "too_short", "There is not enough history to replay yet."
    elif noise_pct > noisy_week_pct:
        verdict = "noisy"
        why = f"A signal would have fired in {noise_pct:g}% of the weeks: too often to be news."
    elif caught_pct is not None and caught_pct < min_caught_pct:
        verdict = "misses"
        why = f"It caught {caught_n} of {len(judged)} real incidents ({caught_pct:g}%)."
    elif caught_pct is not None:
        verdict = "good"
        why = (
            f"It caught {caught_n} of {len(judged)} real incidents, "
            f"with signals in {noise_pct:g}% of weeks."
        )
    else:
        verdict, why = (
            "reasonable",
            f"Signals in {noise_pct:g}% of weeks. No incidents given to check against.",
        )
    return {
        "verdict": verdict,
        "why": why,
        "weeks_replayed": weeks,
        "weeks_with_signal": with_signal,
        "noise_pct": noise_pct,
        "episodes": len(eps),
        "longest_episode": max((e["weeks"] for e in eps), default=0),
        "caught_pct": caught_pct,
        "incidents": caught,
        "top_episodes": sorted(eps, key=lambda e: e["biggest_impact"], reverse=True)[:8],
    }
