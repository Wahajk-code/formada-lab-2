"""Discovery cards: the unit the team edits, locks and mentions in the chat (pure rules, no I/O).

A card is one entry of the discovery answer: a table, a join between two tables, a data-quality
issue, a coverage area, a question or a semantic view. Each has a stable id, a short list of
fields that may change, and belongs to one section. The rules here are what keep the AI in its
lane:
- only cards the team named (or edited by hand) can change;
- a locked card (or a card in a locked section) never changes, even if the AI returns it changed;
- only the listed fields can change, with checked values;
- a change that does nothing is dropped;
- a join the team removed stays removed, and a join the team locked or added stays, after a rerun.
"""

import copy
import re
from typing import Any

MAX_MENTIONS = 8  # cards one instruction may name
LARGE_CHANGES = 6  # more changed fields than this needs a second confirmation
MAX_TEXT = 2000
MAX_ITEMS = 12

# kind -> the fields that may change. Names that identify a card (table name, issue title,
# question text, coverage family, view name) are fixed, so a card id never changes. A join is
# identified by its two ends, so pointing it elsewhere gives it a new id (the lock follows).
FIELDS: dict[str, tuple[str, ...]] = {
    "table": ("purpose", "grain", "key_columns"),
    "join": ("confidence", "column", "references_table", "references_column"),
    "issue": ("severity", "evidence", "impact", "suggested_handling"),
    "coverage": ("status", "evidence"),
    "question": ("why", "to"),
    "view": ("purpose", "grain", "caveats"),
}
JOIN_ENDS = ("column", "references_table", "references_column")
LIST_FIELDS = {"key_columns", "caveats"}
ENUMS: dict[str, tuple[str, ...]] = {
    "severity": ("high", "medium", "low"),
    "status": ("present", "partial", "missing"),
    "to": ("client", "team"),
    "confidence": ("high", "medium", "low"),
}
SECTION_OF = {
    "table": "guide",
    "view": "guide",
    "join": "relationships",
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
PREFIX = {"table": "t", "join": "j", "issue": "i", "coverage": "c", "question": "q", "view": "v"}


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:48]


def _short(name: str) -> str:
    return str(name).split(".")[-1]


def join_id(table: str, join: dict[str, Any]) -> str:
    return (
        f"j:{table}.{join.get('column', '')}>"
        f"{join.get('references_table', '')}.{join.get('references_column', '')}"
    )


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


def label(kind: str, item: dict[str, Any], owner: str = "") -> str:
    if kind in ("table", "view"):
        return _short(item.get(kind, ""))
    if kind == "join":
        left = f"{_short(owner)}.{item.get('column', '')}"
        right = f"{_short(item.get('references_table', ''))}.{item.get('references_column', '')}"
        return f"{left} to {right}"
    if kind == "coverage":
        return str(item.get("family", "")).replace("_", " ")
    if kind == "issue":
        return str(item.get("title", ""))
    return str(item.get("question", ""))[:80]


def joins(out: dict[str, Any]) -> dict[str, tuple[dict[str, Any], dict[str, Any]]]:
    """Every join of the answer: id -> (the table that owns it, the live join entry)."""
    found: dict[str, tuple[dict[str, Any], dict[str, Any]]] = {}
    for t in out.get("tables") or []:
        for j in t.get("joins") or []:
            found.setdefault(join_id(str(t.get("table", "")), j), (t, j))
    return found


def index(out: dict[str, Any]) -> dict[str, tuple[str, dict[str, Any]]]:
    """Every card of a discovery answer: id -> (kind, the live entry)."""
    cards: dict[str, tuple[str, dict[str, Any]]] = {}
    for kind, field in LISTS.items():
        for item in out.get(field) or []:
            cards.setdefault(card_id(kind, item), (kind, item))
    for cid, (_, j) in joins(out).items():
        cards.setdefault(cid, ("join", j))
    return cards


def owner_of(out: dict[str, Any], cid: str) -> str:
    """The table that owns a join card ('' for any other card)."""
    found = joins(out).get(cid)
    return str(found[0].get("table", "")) if found else ""


def view(kind: str, item: dict[str, Any], owner: str = "") -> dict[str, Any]:
    """What the chat and the AI get to see of a card: its name and its editable fields."""
    shown = {"name": label(kind, item, owner), "kind": kind}
    if kind == "join":
        shown["from_table"] = owner
    return {**shown, **{f: item.get(f) for f in FIELDS[kind]}}


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


def _resolve_table(out: dict[str, Any], name: str) -> str | None:
    """The scan's own name for a table, matched on the short name, or None."""
    want = _short(name).upper()
    for t in out.get("tables") or []:
        if _short(str(t.get("table", ""))).upper() == want:
            return str(t["table"])
    return None


def _columns(profile: dict[str, Any] | None, table: str) -> dict[str, str] | None:
    """The profiled columns of a table as {UPPER: real name}, or None when it is not known."""
    for t in (profile or {}).get("tables", []):
        if _short(str(t.get("table", ""))).upper() == _short(table).upper():
            cols = {
                str(c.get("column", "")).upper(): str(c.get("column", ""))
                for c in t.get("columns", [])
            }
            return cols or None
    return None


def check_join(
    out: dict[str, Any], table: str, join: dict[str, Any], profile: dict[str, Any] | None
) -> dict[str, Any]:
    """The join with its tables and columns named as the scan names them, or ValueError with a
    plain reason."""
    ref = _resolve_table(out, str(join.get("references_table", "")))
    owner = _resolve_table(out, table)
    if owner is None:
        raise ValueError(f"{_short(table)} is not in the scan")
    if ref is None:
        raise ValueError(f"{_short(str(join.get('references_table', '')))} is not in the scan")
    fixed = {**join, "references_table": ref}
    for tbl, key in ((owner, "column"), (ref, "references_column")):
        known = _columns(profile, tbl)
        if known is None:
            continue
        real = known.get(str(join.get(key)).upper())
        if real is None:
            raise ValueError(f"{_short(tbl)} has no column {join.get(key)}")
        fixed[key] = real
    return fixed


def apply_changes(
    out: dict[str, Any],
    changes: list[dict[str, Any]],
    lock: bool,
    profile: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[dict[str, str]]]:
    """A copy of the answer with the allowed changes applied.

    Returns (new answer, changes applied with before and after, changes refused with a reason).
    Each change is {"card_id", "field", "value"}. A locked card, a card in a locked section, a
    field not on the card's list and a bad value are refused; a change that does nothing is
    dropped. When lock is true (a hand edit) every card that changed is locked. Pointing a join
    at other tables or columns gives it a new id; later changes to it in the same batch may still
    use the old id, and the lock moves to the new one."""
    data: dict[str, Any] = copy.deepcopy(out)
    applied: list[dict[str, Any]] = []
    refused: list[dict[str, str]] = []
    touched: set[str] = set()
    alias: dict[str, str] = {}

    def now(cid: str) -> str:
        while cid in alias:
            cid = alias[cid]
        return cid

    for ch in changes:
        asked = str(ch.get("card_id", ""))
        field = str(ch.get("field", ""))
        cid = now(asked)
        if reason := is_locked(data, cid):
            refused.append({"card_id": asked, "field": field, "reason": reason})
            continue
        cards = index(data)
        kind, item = cards[cid]
        if field not in FIELDS[kind]:
            refused.append({"card_id": asked, "field": field, "reason": "this field cannot change"})
            continue
        try:
            value = coerce_value(field, ch.get("value"))
        except ValueError as exc:
            refused.append({"card_id": asked, "field": field, "reason": str(exc)})
            continue
        before = item.get(field)
        if before == value:
            continue
        owner = owner_of(data, cid) if kind == "join" else ""
        if kind == "join" and field in JOIN_ENDS:
            try:
                fixed = check_join(data, owner, {**item, field: value}, profile)
            except ValueError as exc:
                refused.append({"card_id": asked, "field": field, "reason": str(exc)})
                continue
            new = join_id(owner, fixed)
            if new != cid and new in cards:
                refused.append({"card_id": asked, "field": field,
                                "reason": "that relationship already exists"})  # fmt: skip
                continue
            value = fixed[field]
            item[field] = value
            if new != cid:
                alias[cid] = new
                if cid in data.get("locked_cards", []):
                    data["locked_cards"] = [new if c == cid else c for c in data["locked_cards"]]
            touched.add(new)
        else:
            item[field] = value
            touched.add(cid)
        applied.append(
            {
                "card_id": asked,
                "name": label(kind, item, owner),
                "field": field,
                "before": before,
                "after": value,
            }
        )
    if lock and touched:
        data["locked_cards"] = sorted(set(data.get("locked_cards", [])) | {now(t) for t in touched})
    return data, applied, refused


def remove_join(out: dict[str, Any], cid: str) -> dict[str, Any]:
    """A copy of the answer without one join. The join stays removed after a rerun. ValueError with
    a plain reason when it cannot be removed (locked, or not there)."""
    reason = is_locked(out, cid)
    found = joins(out).get(cid)
    if found is None:
        raise ValueError("this relationship is not in the proposal")
    if reason:
        raise ValueError(reason)
    data: dict[str, Any] = copy.deepcopy(out)
    table, _ = joins(data)[cid]
    table["joins"] = [j for j in table["joins"] if join_id(str(table["table"]), j) != cid]
    data["removed_joins"] = sorted(set(data.get("removed_joins", [])) | {cid})
    data["locked_cards"] = [c for c in data.get("locked_cards", []) if c != cid]
    return data


def add_join(
    out: dict[str, Any],
    table: str,
    column: str,
    references_table: str,
    references_column: str,
    profile: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    """A copy of the answer with a relationship the team declares, locked so a rerun keeps it.
    Returns (answer, the new card id). ValueError with a plain reason when it does not fit."""
    if "relationships" in out.get("locked_sections", []):
        raise ValueError("the relationships section is locked")
    owner = _resolve_table(out, table)
    if owner is None:
        raise ValueError(f"{_short(table)} is not in the scan")
    join = check_join(
        out,
        owner,
        {
            "column": coerce_value("column", column),
            "references_table": coerce_value("references_table", references_table),
            "references_column": coerce_value("references_column", references_column),
            "confidence": "high",
        },
        profile,
    )
    cid = join_id(owner, join)
    if cid in joins(out):
        raise ValueError("that relationship already exists")
    data: dict[str, Any] = copy.deepcopy(out)
    next(t for t in data["tables"] if t["table"] == owner).setdefault("joins", []).append(join)
    data["locked_cards"] = sorted(set(data.get("locked_cards", [])) | {cid})
    data["removed_joins"] = [c for c in data.get("removed_joins", []) if c != cid]
    return data, cid


def restore_locked(new: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    """Put the team's decisions back into a fresh or revised answer: locked cards field by field,
    locked joins that the new answer lost, and joins the team removed stay removed. A locked card
    whose table the new answer no longer has leaves the lock list."""
    removed = list(previous.get("removed_joins", []))
    keep = list(previous.get("locked_cards", []))
    if not removed and not keep:
        return new
    data: dict[str, Any] = copy.deepcopy(new)
    for t in data.get("tables") or []:
        t["joins"] = [j for j in t.get("joins") or [] if join_id(str(t["table"]), j) not in removed]
    if removed:
        data["removed_joins"] = removed
    old, old_joins = index(previous), joins(previous)
    kept: list[str] = []
    for cid in keep:
        fresh = index(data)
        if cid in old and cid in fresh and old[cid][0] == fresh[cid][0]:
            for field in FIELDS[old[cid][0]]:
                fresh[cid][1][field] = copy.deepcopy(old[cid][1].get(field))
            kept.append(cid)
        elif cid in old_joins and cid not in fresh:
            # The team's locked join is missing from the new answer: put it back on its table.
            owner_name = old_joins[cid][0].get("table")
            owner = next(
                (t for t in data.get("tables") or [] if t.get("table") == owner_name), None
            )
            if owner is not None:
                owner.setdefault("joins", []).append(copy.deepcopy(old_joins[cid][1]))
                kept.append(cid)
    return {**data, "locked_cards": kept}


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
