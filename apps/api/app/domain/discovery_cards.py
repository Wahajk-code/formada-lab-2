"""Discovery cards: the unit the team edits, locks and mentions in the chat (pure rules, no I/O).

A card is one entry of the discovery answer: a table, a data-quality issue, a coverage area, a
question or a semantic view. Each has a stable id, a short list of fields that may change, and
belongs to one section. The rules here are what keep the AI in its lane:
- only cards the team named (or edited by hand) can change;
- a locked card (or a card in a locked section) never changes, even if the AI returns it changed;
- only the listed fields can change, with checked values;
- a change that does nothing is dropped.
"""

import copy
import re
from typing import Any

MAX_MENTIONS = 8  # cards one instruction may name
LARGE_CHANGES = 6  # more changed fields than this needs a second confirmation
MAX_TEXT = 2000
MAX_ITEMS = 12

# kind -> the fields that may change. Names that identify a card (table name, issue title,
# question text, coverage family, view name) are fixed, so a card id never changes.
FIELDS: dict[str, tuple[str, ...]] = {
    "table": ("purpose", "grain", "key_columns"),
    "issue": ("severity", "evidence", "impact", "suggested_handling"),
    "coverage": ("status", "evidence"),
    "question": ("why", "to"),
    "view": ("purpose", "grain", "caveats"),
}
LIST_FIELDS = {"key_columns", "caveats"}
ENUMS: dict[str, tuple[str, ...]] = {
    "severity": ("high", "medium", "low"),
    "status": ("present", "partial", "missing"),
    "to": ("client", "team"),
}
SECTION_OF = {
    "table": "guide",
    "view": "guide",
    "issue": "gaps",
    "coverage": "gaps",
    "question": "gaps",
}
LISTS = {
    "table": "tables",
    "issue": "quality_issues",
    "coverage": "coverage",
    "question": "questions",
    "view": "semantic_views",
}
PREFIX = {"table": "t", "issue": "i", "coverage": "c", "question": "q", "view": "v"}
KIND_OF = {v: k for k, v in PREFIX.items()}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:48]


def _name(kind: str, item: dict[str, Any]) -> str:
    if kind == "table":
        return str(item.get("table", ""))
    if kind == "view":
        return str(item.get("view", ""))
    if kind == "coverage":
        return str(item.get("family", ""))
    if kind == "issue":
        return slug(item.get("title", ""))
    return slug(item.get("question", ""))


def card_id(kind: str, item: dict[str, Any]) -> str:
    return f"{PREFIX[kind]}:{_name(kind, item)}"


def label(kind: str, item: dict[str, Any]) -> str:
    if kind in ("table", "view"):
        return str(item.get(kind, "")).split(".")[-1]
    if kind == "coverage":
        return str(item.get("family", "")).replace("_", " ")
    if kind == "issue":
        return str(item.get("title", ""))
    return str(item.get("question", ""))[:80]


def index(out: dict[str, Any]) -> dict[str, tuple[str, dict[str, Any]]]:
    """Every card of a discovery answer: id -> (kind, the live entry)."""
    cards: dict[str, tuple[str, dict[str, Any]]] = {}
    for kind, field in LISTS.items():
        for item in out.get(field) or []:
            cards.setdefault(card_id(kind, item), (kind, item))
    return cards


def view(kind: str, item: dict[str, Any]) -> dict[str, Any]:
    """What the chat and the AI get to see of a card: its name and its editable fields."""
    return {"name": label(kind, item), "kind": kind, **{f: item.get(f) for f in FIELDS[kind]}}


def is_locked(out: dict[str, Any], cid: str) -> str | None:
    """Why a card cannot change right now, or None when it can."""
    cards = index(out)
    if cid not in cards:
        return "this card is not in the proposal"
    kind, _ = cards[cid]
    if SECTION_OF[kind] in out.get("locked_sections", []):
        return f"the {SECTION_OF[kind]} section is locked"
    if cid in out.get("locked_cards", []):
        return "this card is locked"
    return None


def coerce_value(field: str, value: Any) -> Any:
    """A checked value for one field, or ValueError with a plain reason."""
    if field in LIST_FIELDS:
        items = re.split(r"[,\n]", value) if isinstance(value, str) else list(value or [])
        items = [str(i).strip() for i in items if str(i).strip()]
        if len(items) > MAX_ITEMS or any(len(i) > 200 for i in items):
            raise ValueError(f"{field}: too many or too long entries")
        return items
    text = str(value if value is not None else "").strip()
    if field in ENUMS:
        text = text.lower()
        if text not in ENUMS[field]:
            raise ValueError(f"{field} must be one of {', '.join(ENUMS[field])}")
        return text
    if not text:
        raise ValueError(f"{field} cannot be empty")
    if len(text) > MAX_TEXT:
        raise ValueError(f"{field} is too long")
    return text


def apply_changes(
    out: dict[str, Any], changes: list[dict[str, Any]], lock: bool
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]]]:
    """A copy of the answer with the allowed changes applied.

    Returns (new answer, changes applied with before and after, changes refused with a reason).
    Each change is {"card_id", "field", "value"}. A locked card, a card in a locked section, a
    field not on the card's list and a bad value are refused; a change that does nothing is
    dropped. When lock is true (a hand edit) every card that changed is locked."""
    data: dict[str, Any] = copy.deepcopy(out)
    cards = index(data)
    applied: list[dict[str, Any]] = []
    refused: list[dict[str, str]] = []
    touched: set[str] = set()
    for ch in changes:
        cid, field = str(ch.get("card_id", "")), str(ch.get("field", ""))
        if reason := is_locked(data, cid):
            refused.append({"card_id": cid, "field": field, "reason": reason})
            continue
        kind, item = cards[cid]
        if field not in FIELDS[kind]:
            refused.append({"card_id": cid, "field": field, "reason": "this field cannot change"})
            continue
        try:
            value = coerce_value(field, ch.get("value"))
        except ValueError as exc:
            refused.append({"card_id": cid, "field": field, "reason": str(exc)})
            continue
        before = item.get(field)
        if before == value:
            continue
        item[field] = value
        touched.add(cid)
        applied.append(
            {
                "card_id": cid,
                "name": label(kind, item),
                "field": field,
                "before": before,
                "after": value,
            }
        )
    if lock and touched:
        data["locked_cards"] = sorted(set(data.get("locked_cards", [])) | touched)
    return data, applied, refused


def restore_locked(new: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    """Put the team's locked cards back into a fresh or revised answer, field by field. A locked
    card the new answer no longer has is dropped from the lock list."""
    keep = list(previous.get("locked_cards", []))
    if not keep:
        return new
    old, fresh = index(previous), index(new)
    kept: list[str] = []
    for cid in keep:
        if cid in old and cid in fresh and old[cid][0] == fresh[cid][0]:
            kind = old[cid][0]
            for field in FIELDS[kind]:
                fresh[cid][1][field] = copy.deepcopy(old[cid][1].get(field))
            kept.append(cid)
    return {**new, "locked_cards": kept}


def filter_ai_changes(
    out: dict[str, Any], mentioned: list[str], proposed: list[dict[str, Any]]
) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    """Keep only the AI's changes to cards the team named. Anything else is refused with a reason
    (apply_changes then refuses locked cards, bad fields and bad values)."""
    ok: list[dict[str, Any]] = []
    refused: list[dict[str, str]] = []
    named = set(mentioned)
    for ch in proposed:
        cid = str(ch.get("card_id", ""))
        if cid not in named:
            refused.append({"card_id": cid, "field": str(ch.get("field", "")),
                            "reason": "this card was not mentioned"})  # fmt: skip
            continue
        ok.append(ch)
    return ok, refused
