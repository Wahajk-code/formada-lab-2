# ruff: noqa: E501  (the one-line labels are product copy for the console)
"""One accuracy picture per client, from the evidence we already hold.

Six pieces of evidence, each answering one plain question:

- Reconciliation: do our numbers match the figures the client already trusts?
- Benchmarks: did the AI read the data the way the data says (the checks on each AI step)?
- Detection: would our signals have fired sensibly on this client's own history (backtest)?
- Stability: does an AI step give the same decisions when asked twice?
- Regression: does the current prompt still reproduce the answers the team approved?
- People: when owners see the cards, how often do they say the number is wrong?

Each piece is `good`, `watch`, `bad` or `none` (not measured yet). The overall standing is the worst
one that has been measured, so a gap never hides behind a good average.

Pure: no I/O. `services/validation.py` gathers the evidence.
"""

from typing import Any

GOOD, WATCH, BAD, NONE = "good", "watch", "bad", "none"
ORDER = {NONE: 0, GOOD: 1, WATCH: 2, BAD: 3}


def feedback_rates(
    *, cards: int, actioned: int, not_relevant: int, impossible: int, wrong_number: int,
    max_wrong_number_pct: float, min_feedback: int,
) -> dict[str, Any]:  # fmt: skip
    """What owners said about the cards. A wrong-number report is a not-relevant answer whose reason
    says the number looks wrong; it is counted against the cards that were rated."""
    rated = actioned + not_relevant + impossible
    wrong_pct = round(wrong_number / rated * 100, 1) if rated else None
    if rated < min_feedback:
        status = NONE
    else:
        status = GOOD if (wrong_pct or 0) <= max_wrong_number_pct else BAD
    return {
        "cards": cards,
        "rated": rated,
        "rated_pct": round(rated / cards * 100, 1) if cards else None,
        "action_rate_pct": round(actioned / rated * 100, 1) if rated else None,
        "not_relevant_pct": round(not_relevant / rated * 100, 1) if rated else None,
        "impossible_pct": round(impossible / rated * 100, 1) if rated else None,
        "wrong_number": wrong_number,
        "wrong_number_pct": wrong_pct,
        "status": status,
    }


def _from_verdict(verdict: str | None, good: tuple[str, ...], watch: tuple[str, ...]) -> str:
    if verdict is None:
        return NONE
    return GOOD if verdict in good else WATCH if verdict in watch else BAD


def layers(
    *, reconciliation: dict[str, Any] | None, benchmarks: dict[str, str], backtests: list[str],
    stability: list[str], regression: list[str], people: dict[str, Any],
) -> list[dict[str, Any]]:  # fmt: skip
    """The six pieces as `{key, label, status, detail}`.

    reconciliation: the summary from `reconcile.summarize`. benchmarks: step -> verdict
    (confirmed / mostly / doubtful). backtests, stability, regression: the latest verdict of each
    thing that was tested."""
    rec_status, rec_detail = (
        NONE,
        "No control totals yet: ask the client for three or four figures.",
    )
    if reconciliation and reconciliation["total"]:
        n, ok = reconciliation["total"], reconciliation["matched"]
        rec_status = (
            GOOD
            if reconciliation["verdict"] == "reconciled"
            else BAD
            if reconciliation["off"]
            else WATCH
        )
        rec_detail = f"{ok} of {n} control totals match."
        if reconciliation["worst_pct"] is not None and ok != n:
            rec_detail += f" Furthest apart: {reconciliation['worst_pct']:g}%."

    def worst(statuses: list[str]) -> str:
        return max(statuses, key=ORDER.__getitem__) if statuses else NONE

    bench = [_from_verdict(v, ("confirmed",), ("mostly",)) for v in benchmarks.values()]
    back = [_from_verdict(v, ("good", "reasonable"), ("noisy", "too_short")) for v in backtests]
    stab = [_from_verdict(v, ("stable",), ("mostly",)) for v in stability]
    reg = [_from_verdict(v, ("holds",), ()) for v in regression]

    def count(statuses: list[str], what: str) -> str:
        if not statuses:
            return f"No {what} yet."
        bad = sum(1 for s in statuses if s == BAD)
        watch = sum(1 for s in statuses if s == WATCH)
        return f"{len(statuses) - bad - watch} of {len(statuses)} {what} are fine."

    pct = people["wrong_number_pct"]
    people_detail = (
        f"{people['rated']} cards rated; wrong-number reports on {pct:g}% of them."
        if people["status"] != NONE
        else f"Only {people['rated']} cards rated so far: too few to judge."
    )
    return [
        {"key": "reconciliation", "label": "Our numbers against the client's", "status": rec_status, "detail": rec_detail},
        {"key": "benchmarks", "label": "AI steps read the data correctly", "status": worst(bench), "detail": count(bench, "AI steps")},
        {"key": "detection", "label": "Signals on the client's history", "status": worst(back), "detail": count(back, "metrics replayed")},
        {"key": "stability", "label": "Same answer when asked twice", "status": worst(stab), "detail": count(stab, "stability tests")},
        {"key": "regression", "label": "Approved answers still reproduced", "status": worst(reg), "detail": count(reg, "regression tests")},
        {"key": "people", "label": "Owners say the numbers are right", "status": people["status"], "detail": people_detail},
    ]  # fmt: skip


def overall(parts: list[dict[str, Any]]) -> dict[str, str]:
    measured = [p for p in parts if p["status"] != NONE]
    if not measured:
        return {"status": NONE, "text": "Nothing has been measured yet."}
    status = max((p["status"] for p in measured), key=ORDER.__getitem__)
    gaps = [p["label"] for p in measured if p["status"] == status] if status != GOOD else []
    text = {
        GOOD: f"All {len(measured)} measured pieces are fine.",
        WATCH: f"Worth a look: {', '.join(gaps).lower()}.",
        BAD: f"Not yet to be trusted: {', '.join(gaps).lower()}.",
    }[status]
    return {"status": status, "text": text}
