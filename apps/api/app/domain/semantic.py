"""Semantic views as a data source (discovery and mapping).

Some customers keep their business model in a Snowflake semantic view: named dimensions and
metrics over base tables the reading role may not see. A role can still query the view with
`SELECT ... FROM SEMANTIC_VIEW(db.schema.view DIMENSIONS t.d METRICS t.m)`, which is one
read-only SELECT, so a mapping can use it as its source.

Pure: builds the metadata SELECTs, summarises what they return for the agents, and checks that
a mapping only names things the view really has.
"""

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Any

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
QUALIFIED_VIEW = re.compile(
    r"\bsemantic_view\s*\(\s*([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)",
    re.IGNORECASE,
)
REF = re.compile(r"\b([A-Za-z_][\w$]*)\.([A-Za-z_][\w$]*)\b")
KEYWORDS = {"dimensions", "metrics", "facts", "where"}

MAX_DIMS_PER_TABLE = 90  # tables that carry metrics (the facts)
MAX_DIMS_LOOKUP = 16  # lookup tables: enough to see what they describe
# Fields that identify, name or date a record come first, so a cap never hides a key.
LIKELY_KEY = re.compile(
    r"(^|_)(ID|NAME|NUMBER|SKU|CODE|DATE|STATUS|TYPE|CHANNEL|ETA|LINE|QUANTITY|COST|RATE)($|_)"
)
MAX_TABLES_PER_VIEW = 40


def check_ident(name: str) -> str:
    if not IDENT.match(name):
        raise ValueError(f"unsafe identifier {name!r}")
    return name


def _from(db: str, view: str) -> str:
    return f"{check_ident(db)}.information_schema.{view}"


def views_sql(database: str) -> str:
    return (
        f"select catalog as view_catalog, schema as view_schema, name as view_name, comment "
        f"from {_from(database, 'semantic_views')} order by 2, 3"
    )


def tables_sql(database: str) -> str:
    return (
        "select semantic_view_schema as view_schema, semantic_view_name as view_name, "
        "name as table_name, base_table_schema, base_table_name, comment "
        f"from {_from(database, 'semantic_tables')} order by 1, 2, 3"
    )


def dimensions_sql(database: str) -> str:
    return (
        "select semantic_view_schema as view_schema, semantic_view_name as view_name, "
        "table_name, name, data_type, comment "
        f"from {_from(database, 'semantic_dimensions')} order by 1, 2, 3, 4"
    )


def metrics_sql(database: str) -> str:
    return (
        "select semantic_view_schema as view_schema, semantic_view_name as view_name, "
        "table_name, name, data_type, expression, comment "
        f"from {_from(database, 'semantic_metrics')} order by 1, 2, 3, 4"
    )


def relationships_sql(database: str) -> str:
    return (
        "select semantic_view_schema as view_schema, semantic_view_name as view_name, "
        "table_name, foreign_keys, ref_table_name, ref_keys "
        f"from {_from(database, 'semantic_relationships')} order by 1, 2, 3"
    )


def summarize(
    views: Sequence[Mapping[str, Any]],
    tables: Sequence[Mapping[str, Any]],
    dimensions: Sequence[Mapping[str, Any]],
    metrics: Sequence[Mapping[str, Any]],
    relationships: Sequence[Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """Each view as a compact, name-only description: tables, dimensions, metrics, links.

    The agents get names, types, comments and metric formulas, never data values. Tables that
    carry metrics come first (they are the fact tables) and long dimension lists are capped.
    """

    def key(r: Mapping[str, Any]) -> tuple[str, str]:
        return str(r["view_schema"]).upper(), str(r["view_name"]).upper()

    out: list[dict[str, Any]] = []
    for v in views:
        vk = key(v)
        per: dict[str, dict[str, Any]] = {}
        for t in tables:
            if key(t) == vk:
                per[str(t["table_name"]).upper()] = {
                    "table": str(t["table_name"]).upper(),
                    "base_table": f"{t.get('base_table_schema')}.{t.get('base_table_name')}",
                    "comment": (t.get("comment") or "")[:160],
                    "dimensions": [],
                    "metrics": [],
                }
        for d in dimensions:
            if key(d) == vk and str(d["table_name"]).upper() in per:
                per[str(d["table_name"]).upper()]["dimensions"].append(
                    {"name": str(d["name"]).upper(), "type": d.get("data_type"),
                     "comment": (d.get("comment") or "")[:100]}
                )  # fmt: skip
        for m in metrics:
            if key(m) == vk and str(m["table_name"]).upper() in per:
                per[str(m["table_name"]).upper()]["metrics"].append(
                    {"name": str(m["name"]).upper(), "type": m.get("data_type"),
                     "expression": (m.get("expression") or "")[:160],
                     "comment": (m.get("comment") or "")[:100]}
                )  # fmt: skip
        shown = sorted(
            (t for t in per.values() if t["dimensions"] or t["metrics"]),
            key=lambda t: (-len(t["metrics"]), t["table"]),
        )
        for t in shown:
            t["dimension_count"] = len(t["dimensions"])
            fact = bool(t["metrics"])
            ranked = sorted(
                t["dimensions"], key=lambda d: (not LIKELY_KEY.search(d["name"]), d["name"])
            )
            t["dimensions"] = [
                d if fact else {"name": d["name"], "type": d["type"]}  # lookups: no comments
                for d in ranked[: MAX_DIMS_PER_TABLE if fact else MAX_DIMS_LOOKUP]
            ]
        links = [
            f"{r['table_name']} ({r['foreign_keys']}) -> {r['ref_table_name']} ({r['ref_keys']})"
            for r in relationships
            if key(r) == vk
        ]
        out.append(
            {
                "view": f"{vk[0]}.{vk[1]}",
                "comment": (v.get("comment") or "")[:300],
                "tables": shown[:MAX_TABLES_PER_VIEW],
                "tables_not_shown": max(0, len(shown) - MAX_TABLES_PER_VIEW),
                "relationships": links[:80],
                "how_to_query": (
                    "select <dimension or metric> as <field>, ... from semantic_view("
                    f"{v['view_catalog']}.{vk[0]}.{vk[1]} dimensions TABLE.DIM, ... "
                    "metrics TABLE.METRIC, ...)"
                ),
            }
        )
    return out


def view_refs(sql: str) -> list[tuple[str, str, str]]:
    """The semantic views a SELECT reads, as (database, schema, name) in upper case."""
    return [tuple(p.upper() for p in m.groups()) for m in QUALIFIED_VIEW.finditer(sql)]  # type: ignore[misc]


def _inner(sql: str) -> list[str]:
    """The text inside each semantic_view( ... ), found by counting parentheses."""
    out: list[str] = []
    for m in re.finditer(r"\bsemantic_view\s*\(", sql, re.IGNORECASE):
        depth, i = 1, m.end()
        while i < len(sql) and depth:
            depth += {"(": 1, ")": -1}.get(sql[i], 0)
            i += 1
        out.append(sql[m.end() : i - 1])
    return out


def strip_views(sql: str) -> str:
    """The SQL without its semantic_view( ... ) calls, so table checks do not read them."""
    for inner in _inner(sql):
        sql = sql.replace(inner, " ")
    return sql


def check_source(
    archetype: str, sql: str, database: str, known: Iterable[Mapping[str, Any]]
) -> list[str]:
    """Errors for a mapping source that reads a semantic view; empty when it is sound.

    Every named view must exist in the database, and every TABLE.NAME after DIMENSIONS,
    METRICS or FACTS must be a table of that view and a dimension or metric it defines.
    """
    errors: list[str] = []
    views = {str(v["view"]).upper(): v for v in known}
    for db, schema, name in view_refs(sql):
        v = views.get(f"{schema}.{name}")
        if db != database.upper():
            errors.append(f"{archetype}: {db}.{schema}.{name} is outside {database}")
        elif v is None:
            errors.append(f"{archetype}: semantic view {schema}.{name} is not in the warehouse")
    if errors:
        return errors
    for inner in _inner(sql):
        head = QUALIFIED_VIEW.match("semantic_view(" + inner)
        if head is None:
            continue
        v = views[f"{head.group(2)}.{head.group(3)}".upper()]
        names: dict[str, set[str]] = {
            t["table"]: {d["name"] for d in t["dimensions"]} | {m["name"] for m in t["metrics"]}
            for t in v["tables"]
        }
        body = inner[head.end() - len("semantic_view(") :]
        for table, col in REF.findall(body):
            if table.lower() in KEYWORDS:
                continue
            t, c = table.upper(), col.upper()
            if t not in names:
                errors.append(f"{archetype}: {t} is not a table of {v['view']}")
            elif c not in names[t] and v["tables"] and not _capped(v, t):
                errors.append(f"{archetype}: {t}.{c} is not a dimension or metric of {v['view']}")
    return errors


def _capped(view: Mapping[str, Any], table: str) -> bool:
    """True when the profile cut this table's dimension list, so an unseen name may still exist."""
    for t in view["tables"]:
        if t["table"] == table:
            return bool(t["dimension_count"] > len(t["dimensions"]))
    return False


# ---------------------------------------------------------------------------------------------
# Measuring a view's fact tables (read-only aggregates through SEMANTIC_VIEW)
# ---------------------------------------------------------------------------------------------

DATE_PREFERRED = re.compile(r"(TRANSACTION|SNAPSHOT|ORDER|SALE|INVOICE|CREATED)", re.IGNORECASE)
KEY_PREFERRED = re.compile(
    r"(^|_)(SKU|ITEM|ID|NAME|NUMBER|CODE|LOCATION|VENDOR|CHANNEL)($|_)", re.I
)
ITEM_LIKE = re.compile(r"^(SKU|ITEM|ITEMID|ITEM_ID|ITEM_NUMBER)$", re.IGNORECASE)
KEY_DIMS_MEASURED = 6
OVERLAP_PROBES = 4


def _is_date(dim: Mapping[str, Any]) -> bool:
    kind = str(dim.get("type") or "").upper()
    return "DATE" in kind or "TIMESTAMP" in kind


def pick_date_dim(table: Mapping[str, Any]) -> str | None:
    """The date field that most likely dates a fact (a transaction or snapshot date)."""
    dates = [str(d["name"]) for d in table["dimensions"] if _is_date(d)]
    preferred = [n for n in dates if DATE_PREFERRED.search(n)]
    pool = preferred or sorted(dates)
    return pool[0] if pool else None


def pick_measure(table: Mapping[str, Any]) -> str | None:
    names = [str(m["name"]) for m in table["metrics"]]
    pool = [n for n in names if "QUANTITY" in n.upper()] or names
    return pool[0] if pool else None


def pick_key_dims(table: Mapping[str, Any], date_dim: str | None) -> list[str]:
    """Up to a few identifying fields to count as filled (item, location, vendor, ids, names)."""
    names = [
        str(d["name"]) for d in table["dimensions"] if not _is_date(d) and d["name"] != date_dim
    ]
    return [n for n in names if KEY_PREFERRED.search(n)][:KEY_DIMS_MEASURED]


def item_dims(table: Mapping[str, Any]) -> list[str]:
    names = [str(d["name"]) for d in table["dimensions"] if ITEM_LIKE.match(str(d["name"]))]
    return sorted(names, key=lambda n: (n.upper() != "SKU", n))


def _ref(table: str, name: str) -> str:
    return f"{check_ident(table)}.{check_ident(name)}"


def view_from(database: str, view: str) -> str:
    schema, _, name = view.partition(".")
    return f"{check_ident(database)}.{check_ident(schema)}.{check_ident(name)}"


def range_sql(database: str, view: str, table: str, date_dim: str, measure: str) -> str:
    """First and last date of a fact and how many distinct dates it has."""
    d = _ref(table, date_dim)
    m = _ref(table, measure)
    return (
        "select min(d) as first_date, max(d) as last_date, count(distinct d) as dates from "
        f"(select {check_ident(date_dim)} as d from semantic_view({view_from(database, view)} "
        f"dimensions {d} metrics {m}))"
    )


def fill_sql(
    database: str, view: str, table: str, date_dim: str, dims: Sequence[str], measure: str,
    since: str,
) -> str:  # fmt: skip
    """Over the recent window: rows (one per combination of the fields) and how many have each
    field filled."""
    check_ident(date_dim)
    cols = ", ".join(f"{check_ident(n)} as k{i}" for i, n in enumerate(dims))
    counts = ", ".join(f"count(k{i}) as f{i}" for i in range(len(dims)))
    fields = ", ".join(_ref(table, n) for n in dims)
    return (
        f"select count(*) as n{', ' + counts if dims else ''} from (select {cols or '1 as k0'} "
        f"from semantic_view({view_from(database, view)} dimensions "
        f"{_ref(table, date_dim)}{', ' + fields if dims else ''} "
        f"metrics {_ref(table, measure)} "
        f"where {_ref(table, date_dim)} >= '{_iso_date(since)}'))"
    )


def _iso_date(value: str) -> str:
    if not re.match(r"^\d{4}-\d{2}-\d{2}", value):
        raise ValueError(f"not a date: {value!r}")
    return value[:10]


def summarize_measure(
    rng: Mapping[str, Any], fill: Mapping[str, Any] | None, dims: Sequence[str]
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "first_date": str(rng.get("first_date"))[:10] if rng.get("first_date") else None,
        "last_date": str(rng.get("last_date"))[:10] if rng.get("last_date") else None,
        "dates": int(rng.get("dates") or 0),
    }
    if fill:
        n = int(fill.get("n") or 0)
        out["recent_rows"] = n
        out["recent_key_fill_pct"] = {
            d: round(100 * int(fill.get(f"f{i}") or 0) / n, 1) if n else 0.0
            for i, d in enumerate(dims)
        }
    return out


def view_codes_sql(
    database: str, view: str, table: str, dim: str, date_dim: str, measure: str, since: str
) -> str:  # fmt: skip
    return (
        f"select distinct upper(trim({check_ident(dim)}::varchar)) as k from "
        f"semantic_view({view_from(database, view)} dimensions "
        f"{_ref(table, dim)}, {_ref(table, date_dim)} "
        f"metrics {_ref(table, measure)} "
        f"where {_ref(table, date_dim)} >= '{_iso_date(since)}') where k is not null"
    )


def table_codes_sql(database: str, schema_table: str, column: str, date_col: str, days: int) -> str:
    schema, _, name = schema_table.partition(".")
    fq = f"{check_ident(database)}.{check_ident(schema)}.{check_ident(name)}"
    col, dcol = check_ident(column), check_ident(date_col)
    return (
        f"select distinct upper(trim({col}::varchar)) as k from {fq} where {col} is not null "
        f"and {dcol} >= dateadd('day', -{int(days)}, (select max({dcol}) from {fq}))"
    )


def codes_overlap_sql(left: str, right: str) -> str:
    return (
        f"with a as ({left}), b as ({right}) select (select count(*) from a) as left_codes, "
        "(select count(*) from b) as right_codes, "
        "(select count(*) from a join b using (k)) as shared"
    )


def summarize_overlap(left: str, right: str, row: Mapping[str, Any]) -> dict[str, Any]:
    right_n, shared = int(row.get("right_codes") or 0), int(row.get("shared") or 0)
    return {
        "left": left,
        "right": right,
        "left_codes": int(row.get("left_codes") or 0),
        "right_codes": right_n,
        "shared": shared,
        "pct_of_right": round(100 * shared / right_n, 1) if right_n else 0.0,
    }


# ---------------------------------------------------------------------------------------------
# The view's own graph, written by code (never by the AI): every table and every declared link
# ---------------------------------------------------------------------------------------------

LINK = re.compile(
    r"^(\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\) -> (\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\)$"
)


def parse_links(links: Iterable[str]) -> list[dict[str, str]]:
    out: list[dict[str, str]] = []
    for raw in links:
        m = LINK.match(raw)
        if m:
            clean = [re.sub(r'["\s]+', " ", g).strip() for g in m.groups()]
            out.append({"from": clean[0], "keys": clean[1], "to": clean[2], "ref_keys": clean[3]})
    return out


def graph(view: Mapping[str, Any]) -> dict[str, Any]:
    """Each fact table with the tables it reaches (and the key), plus tables nothing reaches."""
    links = parse_links(view.get("relationships", []))
    tables = [t["table"] for t in view.get("tables", [])]
    facts = [t["table"] for t in view.get("tables", []) if t.get("metrics")]
    reached = {link["to"] for link in links if link["from"] in facts}
    return {
        "view": view["view"],
        "tables": len(tables),
        "links": len(links),
        "facts": [
            {
                "table": f,
                "reaches": [
                    {"table": ln["to"], "via": ln["keys"]} for ln in links if ln["from"] == f
                ],
            }
            for f in facts
        ],
        "unlinked_tables": sorted(t for t in tables if t not in facts and t not in reached),
    }
