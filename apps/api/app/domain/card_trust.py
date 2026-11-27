"""Notes on how far a card's number can be trusted, worked out by code from its own evidence.

A card is only as good as the data under it. Some numbers cannot be real: a delivery time of 275
days, a unit cost four times its usual level overnight, a trend built on three weeks. Those are more
often a data problem (a planned date read as an actual one, a price per case read as per item)
than a business problem. The note goes on the card, so the owner checks the source before acting,
and into the card writer's prompt, so the action it suggests starts with that check.

A note is a code with values, so the app can show it in the owner's language; `format_note` gives
the English sentence the card writer reads. Pure. The limits come from RulesConfig
(note_days_over, note_jump_ratio, note_min_history_weeks).
"""

from typing import Any

from app.domain.config import RulesConfig

PERCENT_UNITS = ("percentage points", "%", "percent")

SENTENCES = {
    "days": (
        "{metric} of {value} days is hard to believe. Check that the dates behind it are actual "
        "dates, not planned ones."
    ),
    "percent": "{metric} of {value} is above 100%, which cannot be right. Check the source.",
    "jump_up": (
        "{metric} is {ratio} times its usual level. A change this big is often a data problem "
        "(per case read as per item, rows loaded twice). Confirm it at the source first."
    ),
    "jump_down": (
        "{metric} is about 1/{ratio} of its usual level. A change this big is often a data problem "
        "(per case read as per item, rows loaded twice). Confirm it at the source first."
    ),
    "history": "Based on only {weeks} weeks of history, so 'usual' is not well established.",
}


def format_note(code: str, values: dict[str, Any]) -> str:
    """The English sentence for one note."""
    return SENTENCES[code].format(**values)


def note_codes(evidence: dict[str, Any], rules: RulesConfig) -> list[dict[str, Any]]:
    """What looks off about this number, as [{"code": ..., "values": {...}}]. Empty when nothing."""
    found: list[dict[str, Any]] = []
    metric = str(evidence.get("metric") or "This measure")
    unit = str(evidence.get("unit") or "").lower()
    current = evidence.get("current_value")
    usual = evidence.get("baseline_mean")
    weeks = evidence.get("baseline_weeks")

    if unit == "days" and isinstance(current, int | float) and current > rules.note_days_over:
        found.append({"code": "days", "values": {"metric": metric, "value": f"{current:g}"}})
    if unit in PERCENT_UNITS and isinstance(current, int | float) and abs(current) > 100:
        found.append({"code": "percent", "values": {"metric": metric, "value": f"{current:g}"}})
    if (
        isinstance(current, int | float)
        and isinstance(usual, int | float)
        and usual > 0
        and current > 0
    ):
        ratio = current / usual
        if ratio >= rules.note_jump_ratio:
            found.append({"code": "jump_up", "values": {"metric": metric, "ratio": f"{ratio:.0f}"}})
        elif ratio <= 1 / rules.note_jump_ratio:
            found.append(
                {"code": "jump_down", "values": {"metric": metric, "ratio": f"{1 / ratio:.0f}"}}
            )
    if isinstance(weeks, int | float) and weeks < rules.note_min_history_weeks:
        found.append({"code": "history", "values": {"weeks": f"{weeks:g}"}})
    return found


def data_notes(evidence: dict[str, Any], rules: RulesConfig) -> list[str]:
    """Plain English sentences saying why this number should be confirmed at the source."""
    return [format_note(n["code"], n["values"]) for n in note_codes(evidence, rules)]
