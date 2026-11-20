"""Metric library: which metrics a customer's data can support, found and not found.

Pure. Each data archetype lists the metrics it is expected to feed (catalog/metric_library).
A metric is FOUND when its template exists, every archetype the template reads is mapped, and
every field it needs is filled in the approved mapping. Otherwise it is NOT FOUND, with the
reason in plain words, so the team sees what the customer's data cannot do yet.
"""

from collections.abc import Iterable, Mapping
from typing import Any

FOUND, NOT_FOUND = "found", "not_found"

# why a metric is not found
NO_TEMPLATE = "no_template"
NOT_MAPPED = "not_mapped"
FIELD_EMPTY = "field_empty"


def _present(field: str, fills: Mapping[str, float] | None) -> bool:
    """A field counts as present unless the approved mapping measured it as completely empty."""
    if fills is None:  # no measurement stored: trust the mapping
        return True
    return fills.get(field, 0) > 0


def judge(
    entry: Mapping[str, Any],
    archetype: str,
    template_archetypes: Iterable[str] | None,
    mapped: Mapping[str, Mapping[str, float] | None],
) -> dict[str, Any]:
    """One library entry against the approved mapping.

    template_archetypes: the archetypes the template reads, or None when no template exists.
    mapped: archetype -> {field: fill_pct} (None when nothing was measured) for approved ones.
    """
    base = {
        "key": entry["key"],
        "archetype": archetype,
        "name": entry["name"],
        "why": entry.get("why", {}),
        "template": entry.get("template"),
        "needs": list(entry.get("needs", [])),
    }
    if archetype not in mapped:
        return {**base, "status": NOT_FOUND, "reason": NOT_MAPPED, "missing": [archetype]}
    if template_archetypes is None:
        return {**base, "status": NOT_FOUND, "reason": NO_TEMPLATE, "missing": []}
    unmapped = sorted(set(template_archetypes) - set(mapped))
    if unmapped:
        return {**base, "status": NOT_FOUND, "reason": NOT_MAPPED, "missing": unmapped}
    fills = mapped[archetype]
    empty = [f for f in base["needs"] if not _present(f, fills)]
    if empty:
        return {**base, "status": NOT_FOUND, "reason": FIELD_EMPTY, "missing": empty}
    return {**base, "status": FOUND, "reason": "", "missing": []}


def explain(row: Mapping[str, Any]) -> str:
    """The reason in one plain sentence."""
    reason, missing = row.get("reason"), ", ".join(row.get("missing") or [])
    if reason == NOT_MAPPED:
        return f"This data is not mapped yet: {missing}."
    if reason == FIELD_EMPTY:
        return f"The mapped data has nothing in: {missing}."
    if reason == NO_TEMPLATE:
        return "No calculation is built for this yet. Add it as a custom metric."
    return ""


def summarize(rows: list[dict[str, Any]]) -> dict[str, int]:
    found = sum(1 for r in rows if r["status"] == FOUND)
    return {"total": len(rows), "found": found, "not_found": len(rows) - found}


KEY_RE = r"^[a-z][a-z0-9_]{2,60}$"


def custom_key(name: str, taken: Iterable[str]) -> str:
    """A safe, unique template key for a custom metric: custom_<name words>."""
    import re

    base = "custom_" + (re.sub(r"[^a-z0-9]+", "_", name.lower()).strip("_") or "metric")
    base = base[:60].rstrip("_")
    used = set(taken)
    key, n = base, 2
    while key in used:
        key, n = f"{base}_{n}", n + 1
    return key
