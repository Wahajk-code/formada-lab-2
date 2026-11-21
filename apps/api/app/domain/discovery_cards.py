"""Discovery cards: the unit the team edits, unlocks and mentions in the chat (pure rules, no I/O).

A card is one entry of the discovery answer: the overview, a table, a join between two tables, a
data-quality issue, a coverage area, a question or a semantic view. A group is a named set of
cards (everything in the Sales area, the Tables block, one table's relationships, a whole tab).

The guide is mostly right, so edits are targeted. EVERYTHING IS LOCKED unless the team unlocks it:
- only unlocked cards can change, by hand, by a rerun, or by the chat;
- the chat changes only cards the team named (a group names all its cards);
- only listed fields can change, with checked values; a change that does nothing is dropped;
- locked cards are put back after any AI rerun, a join the team removed stays removed;
- a hand edit locks the card again when it is saved.
"""

import copy
import re
from typing import Any

MAX_MENTIONS = 8  # chips one instruction may carry (a group is one chip)
MAX_EXPANDED = 60  # cards those chips may expand to
LARGE_CHANGES = 6  # more changed fields than this needs a second confirmation
MAX_TEXT = 2000
MAX_ITEMS = 12

OVERVIEW = "o:overview"

# kind -> the fields that may change. Names that identify a card (table name, issue title,
# question text, coverage family, view name) are fixed, so a card id never changes. A join is
# identified by its two ends, so pointing it elsewhere gives it a new id (the unlock follows).
FIELDS: dict[str, tuple[str, ...]] = {
    "overview": ("summary", "cadence"),
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
    "overview": "guide",
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
PREFIX = {
    "overview": "o",
    "table": "t",
    "join": "j",
    "issue": "i",
    "coverage": "c",
    "question": "q",
    "view": "v",
}
# Kinds a rerun may have dropped that we put back when they are locked. A table is not put back:
# tables come from the scan.
RE_ADD = ("issue", "coverage", "question", "view")

AREA_KEYS = ("sales", "inventory", "purchasing", "shared")
AREA_LABEL = {
    "sales": "Sales",
    "inventory": "Inventory",
    "purchasing": "Purchasing",
    "shared": "Shared lookups",
}
AREA_FAMILIES = {
    "sales": ("sales", "returns", "customers"),
    "inventory": ("inventory", "transfers"),
    "purchasing": ("purchase_orders", "receipts", "vendors"),
    "shared": ("calendar",),
}
# Purchasing and inventory are tested first, so PURCHASE_ORDERS and TRANSFER_ORDERS are not sales.
_AREA_MATCH = (
    ("purchasing", re.compile(r"purchase|vendor|supplier|receipt|po_", re.I)),
    ("inventory", re.compile(r"inventory|stock|item_?location|aggregateitem|transfer", re.I)),
    (
        "sales",
        re.compile(
            r"sales|order|invoice|cash|customer|channel|forecast|abandon|checkout|return"
            r"|wholesale|revenue",
            re.I,
        ),
    ),
)


def slug(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", str(text).lower()).strip("-")[:48]


def _short(name: str) -> str:
    return str(name).split(".")[-1]


def area_of(table: str) -> str:
    name = _short(table)
    for key, rx in _AREA_MATCH:
        if rx.search(name):
            return key
    return "shared"


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
    if kind == "overview":
        return OVERVIEW
    return f"{PREFIX[kind]}:{_name(kind, item)}"


def label(kind: str, item: dict[str, Any], owner: str = "") -> str:
    if kind == "overview":
        return "Overview"
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
    if "summary" in out:
        cards[OVERVIEW] = ("overview", out)
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


# ---- groups: a named set of cards (a heading's whole block) -----------------------------------


def _issue_areas(tables: list[str], issue: dict[str, Any]) -> list[str]:
    """The areas an issue touches, from the tables of the columns it names."""
    names = {t.upper(): t for t in tables} | {_short(t).upper(): t for t in tables}
    hit: list[str] = []
    for col in issue.get("columns") or []:
        table = str(col).rsplit(".", 1)[0]
        found = names.get(table.upper()) or names.get(_short(table).upper())
        if found and area_of(found) not in hit:
            hit.append(area_of(found))
    return hit


def groups(out: dict[str, Any]) -> dict[str, dict[str, Any]]:
    """Every group of the answer: id -> {"label", "members"}. Mirrored on the web side."""
    found: dict[str, dict[str, Any]] = {}

    def add(gid: str, name: str, members: list[str]) -> None:
        if members:
            found[gid] = {"label": name, "members": list(dict.fromkeys(members))}

    tables = [str(t.get("table", "")) for t in out.get("tables") or []]
    cards = index(out)
    views = [card_id("view", v) for v in out.get("semantic_views") or []]
    questions = [card_id("question", q) for q in out.get("questions") or []]
    all_joins = list(joins(out))
    add("g:overview", "Overview", [OVERVIEW] if OVERVIEW in cards else [])
    placed: set[str] = set()
    for key in AREA_KEYS:
        name = AREA_LABEL[key]
        tcards = [card_id("table", {"table": t}) for t in tables if area_of(t) == key]
        cov = [
            card_id("coverage", c)
            for c in out.get("coverage") or []
            if c.get("family") in AREA_FAMILIES[key]
        ]
        iss_items = [q for q in out.get("quality_issues") or [] if key in _issue_areas(tables, q)]
        iss = [card_id("issue", q) for q in iss_items]
        placed |= set(iss)
        add(f"g:tables:{key}", f"{name} tables", tcards)
        add(f"g:coverage:{key}", f"{name} coverage", cov)
        add(f"g:issues:{key}", f"{name} data quality", iss)
        add(f"g:area:{key}", f"{name}: the whole area", tcards + cov + iss)
    add(
        "g:issues:general",
        "Data quality across areas",
        [
            card_id("issue", q)
            for q in out.get("quality_issues") or []
            if card_id("issue", q) not in placed
        ],
    )
    add("g:views", "Customer semantic views", views)
    add("g:questions", "Questions for the customer", questions)
    add("g:joins", "All relationships", all_joins)
    for t in out.get("tables") or []:
        own = [join_id(str(t.get("table", "")), j) for j in t.get("joins") or []]
        add(f"g:joins:{t.get('table', '')}", f"{_short(t.get('table', ''))} relationships", own)
    add(
        "g:section:guide",
        "Data guide",
        ([OVERVIEW] if OVERVIEW in cards else [])
        + [card_id("table", {"table": t}) for t in tables]
        + views,
    )
    add("g:section:relationships", "Relationships", all_joins)
    add(
        "g:section:gaps",
        "Coverage gaps",
        [card_id("coverage", c) for c in out.get("coverage") or []]
        + [card_id("issue", q) for q in out.get("quality_issues") or []]
        + questions,
    )
    return found


def expand(out: dict[str, Any], ids: list[str]) -> list[str]:
    """Card ids with every group replaced by its members (in order, no repeats). ValueError when a
    group does not exist or the result is too large."""
    known = groups(out)
    result: list[str] = []
    for i in ids:
        if i.startswith("g:"):
            if i not in known:
                raise ValueError("that block is not in the proposal")
            result.extend(known[i]["members"])
        else:
            result.append(i)
    result = list(dict.fromkeys(result))
    if len(result) > MAX_EXPANDED:
        raise ValueError(f"that is {len(result)} cards: name fewer than {MAX_EXPANDED + 1}")
    return result


# ---- locks --------------------------------------------------------------------------------------


def is_locked(out: dict[str, Any], cid: str) -> str | None:
    """Why a card cannot change right now, or None when it can. Locked is the default."""
    if cid not in index(out):
        return "this card is not in the proposal"
    if cid in set(out.get("unlocked_cards", [])):
        return None
    return "this card is locked; unlock it to change it"


def set_locks(out: dict[str, Any], ids: list[str], lock: bool) -> dict[str, Any]:
    """A copy of the answer with these cards locked or unlocked (groups are expanded)."""
    data: dict[str, Any] = copy.deepcopy(out)
    members = set(expand(data, ids)) & set(index(data))
    held = set(data.get("unlocked_cards", []))
    data["unlocked_cards"] = sorted(held - members if lock else held | members)
    return data


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
    Each change is {"card_id", "field", "value"}. A locked card, a field not on the card's list and
    a bad value are refused; a change that does nothing is dropped. When lock is true (a hand
    edit) every card that changed is locked again. Pointing a join at other tables or columns
    gives it a new id; later changes to it in the same batch may still use the old id, and the
    unlock moves to the new one."""
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
                if cid in data.get("unlocked_cards", []):
                    data["unlocked_cards"] = [
                        new if c == cid else c for c in data["unlocked_cards"]
                    ]
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
        final = {now(t) for t in touched}
        data["unlocked_cards"] = sorted(set(data.get("unlocked_cards", [])) - final)
    return data, applied, refused


def remove_join(out: dict[str, Any], cid: str) -> dict[str, Any]:
    """A copy of the answer without one join. The join stays removed after a rerun. ValueError with
    a plain reason when it cannot be removed (locked, or not there)."""
    if cid not in joins(out):
        raise ValueError("this relationship is not in the proposal")
    if reason := is_locked(out, cid):
        raise ValueError(reason)
    data: dict[str, Any] = copy.deepcopy(out)
    table, _ = joins(data)[cid]
    table["joins"] = [j for j in table["joins"] if join_id(str(table["table"]), j) != cid]
    data["removed_joins"] = sorted(set(data.get("removed_joins", [])) | {cid})
    data["unlocked_cards"] = [c for c in data.get("unlocked_cards", []) if c != cid]
    return data


def add_join(
    out: dict[str, Any],
    table: str,
    column: str,
    references_table: str,
    references_column: str,
    profile: dict[str, Any] | None = None,
) -> tuple[dict[str, Any], str]:
    """A copy of the answer with a relationship the team declares. It starts locked like every
    card, so a rerun keeps it. Returns (answer, the new card id). ValueError with a plain reason
    when it does not fit."""
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
    data["removed_joins"] = [c for c in data.get("removed_joins", []) if c != cid]
    return data, cid


def restore_locked(new: dict[str, Any], previous: dict[str, Any]) -> dict[str, Any]:
    """Put every locked card back into a fresh or revised answer, field by field. Locked is the
    default, so only cards the team unlocked may differ. A locked issue, coverage line, question
    or view the new answer dropped comes back, a locked join too; joins the team removed stay
    removed. The first answer (no previous one) has nothing to protect."""
    old = index(previous)
    if not old:
        return new
    unlocked = set(previous.get("unlocked_cards", []))
    removed = list(previous.get("removed_joins", []))
    data: dict[str, Any] = copy.deepcopy(new)
    for t in data.get("tables") or []:
        t["joins"] = [j for j in t.get("joins") or [] if join_id(str(t["table"]), j) not in removed]
    if removed:
        data["removed_joins"] = removed
    fresh = index(data)
    old_joins = joins(previous)
    for cid, (kind, item) in old.items():
        if cid in unlocked:
            continue
        if cid in fresh and fresh[cid][0] == kind:
            for field in FIELDS[kind]:
                fresh[cid][1][field] = copy.deepcopy(item.get(field))
        elif kind in RE_ADD:
            data.setdefault(LISTS[kind], []).append(copy.deepcopy(item))
        elif kind == "join":
            owner_name = old_joins[cid][0].get("table")
            owner = next(
                (t for t in data.get("tables") or [] if t.get("table") == owner_name), None
            )
            if owner is not None:
                owner.setdefault("joins", []).append(copy.deepcopy(item))
    present = set(index(data))
    data["unlocked_cards"] = sorted(c for c in unlocked if c in present)
    return data


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
