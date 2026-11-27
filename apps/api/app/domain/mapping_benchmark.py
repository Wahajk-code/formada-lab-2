"""A benchmark for Mapping: obvious things the AI chose, checked against the profile and the shapes.

Same idea as the Discovery benchmark. Code can tell, without any AI and without the warehouse,
whether the mapper read its context: every field of a shape is accounted for, every source column it
names exists in the customer's view and appears in its own SQL, a date field reads a date column and
an amount reads a number, the sales shape reads sales tables and not stock, a field it left empty is
not claimed with high confidence. A mapping that fails these is wrong however good its prose reads.

Pure. Probes have the same shape as the Discovery benchmark's. A probe that cannot be checked (a
type the view does not give, a shortened field list) is skipped, never failed.
"""

import re
from typing import Any

from app.domain.discovery_benchmark import AREA_HINTS, _probe, _short, grade
from app.domain.discovery_cards import _family

# Which area a shape's source tables are named for.
SHAPE_AREA = {
    "sales_line": "sales",
    "wholesale_order_line": "sales",
    "purchase_order": "purchase_orders",
    "purchase_order_line": "purchase_orders",
    "inventory_position": "inventory",
    "inventory_snapshot": "inventory",
}
NUMBER_WORDS = re.compile(
    r"(units|qty|quantity|amount|cost|price|value|sales|revenue|discount|total|on_hand|on_order)",
    re.I,
)
# A field named for something that happened, and a column named or described as only planned.
HAPPENED = re.compile(r"(receiv|receipt|ship|deliver|actual|paid|closed|complet)", re.I)
PLANNED = re.compile(
    r"(?<![a-z])(expected|promised|planned|estimated|scheduled|due|forecast(?:ed)?|eta|requested|target)(?![a-z])",
    re.I,
)
CRITICAL = {"columns_exist", "right_area", "type_fit", "date_meaning"}


def _expected_kind(field: str) -> str | None:
    f = field.lower()
    if f == "date" or f.endswith(("_date", "_at")):
        return "date"
    if NUMBER_WORDS.search(f):
        return "number"
    return None


def _columns(profile: dict[str, Any]) -> dict[tuple[str, str], tuple[Any, bool]]:
    """(TABLE, COLUMN) -> (type, list_was_cut) for every field of the views and every table read."""
    found: dict[tuple[str, str], tuple[Any, bool]] = {}
    for v in profile.get("semantic_views", []):
        for t in v.get("tables", []):
            cut = t.get("dimension_count", 0) > len(t.get("dimensions", []))
            for d in t.get("dimensions", []):
                found[(str(t["table"]).upper(), str(d.get("name", "")).upper())] = (
                    d.get("type"),
                    cut,
                )
            for m in t.get("metrics", []):
                found[(str(t["table"]).upper(), str(m.get("name", "")).upper())] = (
                    m.get("type"),
                    False,
                )
    for t in profile.get("tables", []):
        for c in t.get("columns", []):
            found[(_short(t["table"]), str(c.get("column", "")).upper())] = (c.get("type"), False)
    return found


def _comments(profile: dict[str, Any]) -> dict[tuple[str, str], str]:
    """(TABLE, COLUMN) -> what the customer's own view says that field is."""
    found: dict[tuple[str, str], str] = {}
    for v in profile.get("semantic_views", []):
        for t in v.get("tables", []):
            for d in [*t.get("dimensions", []), *t.get("metrics", [])]:
                if d.get("comment"):
                    key = (str(t["table"]).upper(), str(d.get("name", "")).upper())
                    found[key] = str(d["comment"])
    return found


def _cut_tables(profile: dict[str, Any]) -> set[str]:
    return {
        str(t["table"]).upper()
        for v in profile.get("semantic_views", [])
        for t in v.get("tables", [])
        if t.get("dimension_count", 0) > len(t.get("dimensions", []))
    }


def _split(ref: str) -> tuple[str, str]:
    parts = str(ref).upper().split(".")
    return (parts[-2] if len(parts) > 1 else ""), parts[-1]


def _shape(
    a: dict[str, Any],
    defn: dict[str, Any] | None,
    cols: dict[tuple[str, str], tuple[Any, bool]],
    cut: set[str],
    comments: dict[tuple[str, str], str],
) -> list[dict[str, str]]:
    key, name = str(a["archetype"]), str(a["archetype"]).replace("_", " ")
    status = a.get("status")
    if status == "unmappable":
        ok = not str(a.get("source_sql", "")).strip()
        return [
            _probe(
                f"unmappable:{key}",
                "Shapes",
                f"{name}: says it cannot be built",
                "no query when nothing can be built",
                "no query" if ok else "but it wrote a query",
                "pass" if ok else "fail",
            )
        ]
    probes: list[dict[str, str]] = []
    fields = list(a.get("fields", []))
    named = {str(f.get("field")) for f in fields}
    if defn:
        wanted = [str(f["field"]) for f in defn.get("fields", [])]
        missing = [f for f in wanted if f not in named]
        probes.append(
            _probe(
                f"fields_complete:{key}",
                "Shapes",
                f"{name}: every field is accounted for",
                f"all {len(wanted)} fields (mapped, or empty with a reason)",
                "all there" if not missing else "left out: " + ", ".join(missing[:4]),
                "pass" if not missing else "fail",
            )
        )

    refs = [(f, r) for f in fields for r in f.get("source_columns", [])]
    unknown = []
    for f, r in refs:
        table, column = _split(r)
        if (table, column) in cols or table in cut or not table:
            continue
        unknown.append(f"{f['field']} <- {r}")
    if refs:
        probes.append(
            _probe(
                f"columns_exist:{key}",
                "Shapes",
                f"{name}: every source column exists",
                "each column named is a field of the customer's view",
                "all real" if not unknown else "not found: " + "; ".join(unknown[:3]),
                "pass" if not unknown else "fail",
            )
        )
        sql = str(a.get("source_sql", "")).upper()
        absent = [f"{f['field']} <- {r}" for f, r in refs if _split(r)[1] not in sql]
        probes.append(
            _probe(
                f"columns_in_sql:{key}",
                "Shapes",
                f"{name}: the query reads the columns it names",
                "every column named in the reasoning is in the query",
                "all in the query" if not absent else "not in the query: " + "; ".join(absent[:3]),
                "pass" if not absent else "fail",
            )
        )

    bad_type = []
    for f in fields:
        want = _expected_kind(str(f.get("field", "")))
        for r in f.get("source_columns", []):
            got = cols.get(_split(r), (None, False))[0]
            if want and got and _family(got) not in ("other", want):
                bad_type.append(f"{f['field']} is a {want} but {r} is {_family(got)}")
    if any(_expected_kind(str(f.get("field", ""))) for f in fields):
        probes.append(
            _probe(
                f"type_fit:{key}",
                "Shapes",
                f"{name}: dates read dates, amounts read numbers",
                "a *_date field reads a date column, an amount or quantity reads a number",
                "all fit" if not bad_type else "; ".join(bad_type[:3]),
                "pass" if not bad_type else "fail",
            )
        )

    wrong_date = []
    for f in fields:
        if (
            not HAPPENED.search(str(f.get("field", "")))
            or _expected_kind(str(f["field"])) != "date"
        ):
            continue
        for r in f.get("source_columns", []):
            said = f"{_split(r)[1].replace('_', ' ')} {comments.get(_split(r), '')}"
            if PLANNED.search(said):
                wrong_date.append(
                    f"{f['field']} reads {_split(r)[1]}, which the view calls planned"
                )
    if any(HAPPENED.search(str(f.get("field", ""))) for f in fields):
        probes.append(
            _probe(
                f"date_meaning:{key}",
                "Shapes",
                f"{name}: a date that happened does not read a planned date",
                "received, shipped or delivered dates read actual dates, not expected ones",
                "all actual" if not wrong_date else "; ".join(wrong_date[:3]),
                "pass" if not wrong_date else "fail",
            )
        )

    hint = AREA_HINTS.get(SHAPE_AREA.get(key, ""))
    if hint and refs:
        tables = {_split(r)[0] for _f, r in refs} | set(
            re.findall(r"\b([A-Z_]{4,})\.[A-Z_]+", str(a.get("source_sql", "")).upper())
        )
        ok = any(hint.search(t) for t in tables)
        probes.append(
            _probe(
                f"right_area:{key}",
                "Shapes",
                f"{name}: reads tables of the right area",
                f"tables named for {SHAPE_AREA[key].replace('_', ' ')}",
                "yes" if ok else "reads " + ", ".join(sorted(t for t in tables if t)[:3]),
                "pass" if ok else "fail",
            )
        )

    dishonest = [
        str(f["field"])
        for f in fields
        if not f.get("source_columns") and f.get("confidence") == "high"
    ]
    probes.append(
        _probe(
            f"honest:{key}",
            "Shapes",
            f"{name}: empty fields are not claimed as sure",
            "a field left empty is not high confidence",
            "honest" if not dishonest else "empty but high: " + ", ".join(dishonest[:4]),
            "pass" if not dishonest else "fail",
        )
    )
    empty = [str(f["field"]) for f in fields if not f.get("source_columns")]
    if status == "mapped" and empty:
        probes.append(
            _probe(
                f"status:{key}",
                "Shapes",
                f"{name}: 'mapped' means every field has a source",
                "partly mapped when a field is empty",
                "says mapped, but empty: " + ", ".join(empty[:4]),
                "fail",
            )
        )
    return probes


def run(
    out: dict[str, Any], profile: dict[str, Any] | None, shapes: list[dict[str, Any]] | None
) -> dict[str, Any] | None:
    """The benchmark of one mapping answer, or None when there is nothing to check it against."""
    if not profile or "archetypes" not in out or not out["archetypes"]:
        return None
    cols, cut, comments = _columns(profile), _cut_tables(profile), _comments(profile)
    defs = {str(s["archetype"]): s for s in shapes or []}
    probes: list[dict[str, str]] = []
    answered = {str(a["archetype"]) for a in out["archetypes"]}
    left_out = [k for k in defs if k not in answered]
    if defs:
        probes.append(
            _probe(
                "shapes_answered",
                "Shapes",
                "Every data shape is answered",
                f"all {len(defs)} shapes",
                "all answered" if not left_out else "left out: " + ", ".join(left_out[:4]),
                "pass" if not left_out else "fail",
            )
        )
    for a in out["archetypes"]:
        probes += _shape(a, defs.get(str(a["archetype"])), cols, cut, comments)
    return grade(probes, CRITICAL)
