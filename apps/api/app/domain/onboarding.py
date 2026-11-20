"""AI onboarding rules (ADR 0026). Pure: profile SQL, the shape summary agents read, and the
code checks every agent proposal must pass before the internal team can approve it.

Privacy rule: the warehouse profile is SHAPE only. Agents get names, types, counts, ratios,
date ranges and categorical codes (low-cardinality, non-name columns). Free-text and name
columns only contribute keyword counts (how many distinct values contain "quarantine"), never
values. Numeric columns give fill, zero and negative shares, never amounts.
"""

import math
import re
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import date
from itertools import pairwise
from typing import Any

from app.domain import semantic
from app.domain.config import SCHEMA, coerce

IDENT = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*$")
QUALIFIED = re.compile(
    r"\b([A-Za-z_][A-Za-z0-9_$]*)\.([A-Za-z_][A-Za-z0-9_$]*)\.([A-Za-z_][A-Za-z0-9_$]*)\b"
)
SINGLE_SELECT = re.compile(r"^\s*(select|with)\b", re.IGNORECASE)
WRITE_WORDS = re.compile(
    r"\b(insert|update|delete|merge|create|alter|drop|truncate|grant|revoke|copy|put|call)\b",
    re.IGNORECASE,
)

# Name-like columns never send values; only these generic keywords are counted in them.
NAME_HINT = re.compile(
    r"(NAME|DESCRIPTION|TITLE|ADDRESS|PHONE|EMAIL|POSTAL|CITY|BARCODE|UPC|LATITUDE|LONGITUDE|"
    r"COMMENT|NOTE)",
    re.IGNORECASE,
)
KEYWORDS = (
    "quarantine", "damage", "return", "hold", "defect", "overstock", "web", "online", "ecom",
    "store", "warehouse", "dc", "outlet", "wholesale", "b2b", "amazon", "raw", "material",
    "finished", "kit", "transit", "virtual", "old", "closed", "test", "sample", "retail",
)  # fmt: skip
SNAPSHOT_HINT = re.compile(r"(SNAPSHOT|AS_OF|PERIOD|BUSINESS_DATE|COUNT_DATE)", re.IGNORECASE)
ENTITY_HINT = re.compile(r"(^ITEM$|^LOCATION$|_ID$|^ID$|SKU|STORE|ITEMID$)", re.IGNORECASE)
MAX_CATEGORY_DISTINCT = 25
# Settings never changed during onboarding: access (who sees what) and log retention.
BLOCKED_RULE_KEYS = frozenset(
    {k for k, v in SCHEMA.items() if v.group == "access"} | {"llm_log_retention_days"}
)
MAX_KEYWORD_DISTINCT = 2000
FAMILIES = (
    "inventory", "sales", "returns", "purchase_orders", "receipts", "transfers", "vendors",
    "customers", "calendar",
)  # fmt: skip
PLAYBOOKS = ("purchasing", "sales", "inventory", "executive")


def type_family(data_type: str) -> str:
    t = data_type.upper()
    if any(k in t for k in ("NUMBER", "INT", "DECIMAL", "NUMERIC", "FLOAT", "DOUBLE", "REAL")):
        return "number"
    if any(k in t for k in ("DATE", "TIMESTAMP", "TIME")):
        return "date"
    if "BOOL" in t:
        return "boolean"
    return "text"


def check_ident(name: str) -> str:
    if not IDENT.match(name):
        raise ValueError(f"unsafe identifier {name!r}")
    return name


@dataclass(frozen=True)
class Column:
    name: str
    data_type: str

    @property
    def family(self) -> str:
        return type_family(self.data_type)

    @property
    def name_like(self) -> bool:
        return bool(NAME_HINT.search(self.name))


@dataclass
class TableShape:
    schema: str
    name: str
    kind: str  # BASE TABLE | VIEW
    columns: list[Column] = field(default_factory=list)

    @property
    def qualified(self) -> str:
        return f"{self.schema}.{self.name}"


# ---------------------------------------------------------------------------------------------
# Profile SQL (read-only, aggregate; values never leave as rows except categorical codes)
# ---------------------------------------------------------------------------------------------


def tables_sql(database: str) -> str:
    db = check_ident(database)
    return (
        f"select table_schema, table_name, table_type from {db}.information_schema.tables "
        "where upper(table_schema) <> 'INFORMATION_SCHEMA' order by 1, 2"
    )


def comments_sql(database: str) -> str:
    """Descriptions the customer wrote on tables and columns (the profile keeps them short)."""
    db = check_ident(database)
    return (
        "select table_schema, table_name, column_name, comment "
        f"from {db}.information_schema.columns "
        "where upper(table_schema) <> 'INFORMATION_SCHEMA' and comment is not null "
        "and comment <> '' order by 1, 2, 3"
    )


def columns_sql(database: str) -> str:
    db = check_ident(database)
    return (
        "select table_schema, table_name, column_name, data_type, ordinal_position "
        f"from {db}.information_schema.columns "
        "where upper(table_schema) <> 'INFORMATION_SCHEMA' order by 1, 2, 5"
    )


def table_profile_sql(database: str, table: TableShape) -> str:
    """One row: row count, and per column non-null, distinct, zero/negative or min/max."""
    parts = ["count(*) as n_rows"]
    for i, c in enumerate(table.columns):
        col = check_ident(c.name)
        parts.append(f"count({col}) as nn_{i}")
        parts.append(f"count(distinct {col}) as d_{i}")
        if c.family == "number":
            parts.append(f"sum(case when {col} = 0 then 1 else 0 end) as z_{i}")
            parts.append(f"sum(case when {col} < 0 then 1 else 0 end) as neg_{i}")
        elif c.family == "date":
            parts.append(f"min({col}) as min_{i}")
            parts.append(f"max({col}) as max_{i}")
    return f"select {', '.join(parts)} from {_fq(database, table)}"


def categories_sql(database: str, table: TableShape, column: str) -> str:
    col = check_ident(column)
    return (
        f"select {col} as value, count(*) as n from {_fq(database, table)} "
        f"group by 1 order by 2 desc limit {MAX_CATEGORY_DISTINCT + 5}"
    )


def keywords_sql(database: str, table: TableShape, column: str) -> str:
    """How many DISTINCT values of a name column contain each keyword. No value leaves."""
    col = check_ident(column)
    parts = [
        f"count(distinct case when contains(lower({col}), '{kw}') then {col} end) as kw_{i}"
        for i, kw in enumerate(KEYWORDS)
    ]
    return f"select {', '.join(parts)} from {_fq(database, table)}"


def time_profile_sql(
    database: str, table: TableShape, date_col: str, entity_cols: Sequence[str]
) -> str:
    d = check_ident(date_col)
    ents = ", ".join(
        f"count(distinct {check_ident(c)}) as e_{i}" for i, c in enumerate(entity_cols)
    )
    return (
        f"select {d} as d, count(*) as n_rows{', ' + ents if ents else ''} "
        f"from {_fq(database, table)} group by 1 order by 1"
    )


def first_filled_sql(database: str, table: TableShape, date_col: str) -> str:
    d = check_ident(date_col)
    parts = [
        f"min(case when {check_ident(c.name)} is not null then {d} end) as f_{i}"
        for i, c in enumerate(table.columns)
    ]
    return f"select {', '.join(parts)} from {_fq(database, table)}"


def mix_sql(database: str, table: TableShape, date_col: str, column: str) -> str:
    d, col = check_ident(date_col), check_ident(column)
    return (
        f"select {d} as d, {col} as value, count(*) as n from {_fq(database, table)} "
        "group by 1, 2 order by 1, 2"
    )


def _fq(database: str, table: TableShape) -> str:
    return ".".join(check_ident(p) for p in (database, table.schema, table.name))


# ---------------------------------------------------------------------------------------------
# Shape summary for the agents
# ---------------------------------------------------------------------------------------------


def pct(part: float, whole: float) -> float:
    return round(100 * part / whole, 1) if whole else 0.0


def column_stats(table: TableShape, row: dict[str, Any]) -> list[dict[str, Any]]:
    n = int(row.get("n_rows") or 0)
    out = []
    for i, c in enumerate(table.columns):
        nn = int(row.get(f"nn_{i}") or 0)
        stat: dict[str, Any] = {
            "column": c.name,
            "type": c.data_type,
            "fill_pct": pct(nn, n),
            "distinct": int(row.get(f"d_{i}") or 0),
        }
        if c.family == "number":
            stat["zero_pct"] = pct(float(row.get(f"z_{i}") or 0), nn)
            stat["negative_pct"] = pct(float(row.get(f"neg_{i}") or 0), nn)
        elif c.family == "date":
            stat["min"] = _iso(row.get(f"min_{i}"))
            stat["max"] = _iso(row.get(f"max_{i}"))
        out.append(stat)
    return out


def category_candidates(table: TableShape, stats: list[dict[str, Any]]) -> list[str]:
    return [
        s["column"]
        for c, s in zip(table.columns, stats, strict=True)
        if c.family in ("text", "boolean")
        and not c.name_like
        and 0 < s["distinct"] <= MAX_CATEGORY_DISTINCT
    ]


def keyword_candidates(table: TableShape, stats: list[dict[str, Any]]) -> list[str]:
    return [
        s["column"]
        for c, s in zip(table.columns, stats, strict=True)
        if c.family == "text" and c.name_like and 0 < s["distinct"] <= MAX_KEYWORD_DISTINCT
    ]


def keyword_counts(row: dict[str, Any]) -> list[dict[str, Any]]:
    return [
        {"keyword": kw, "distinct_values": int(row.get(f"kw_{i}") or 0)}
        for i, kw in enumerate(KEYWORDS)
        if int(row.get(f"kw_{i}") or 0) > 0
    ]


def pick_time_table(
    tables: list[TableShape], stats: dict[str, list[dict[str, Any]]], rows: dict[str, int]
) -> tuple[TableShape, str, list[str]] | None:
    """The largest table with a date column that varies (a snapshot or event date), and up to two
    entity-like columns to count per date."""
    for t in sorted(tables, key=lambda t: rows.get(t.qualified, 0), reverse=True):
        n = rows.get(t.qualified, 0)
        if n < 1000:
            continue
        dates = [
            s
            for c, s in zip(t.columns, stats[t.qualified], strict=True)
            if c.family == "date" and 10 <= s["distinct"] <= 2000 and s["fill_pct"] >= 99
        ]
        if not dates:
            continue
        # The grain date repeats across many rows: prefer a snapshot-like name, else the date
        # column with the FEWEST distinct values (audit dates such as LASTMODIFIED vary per row).
        named = [s for s in dates if SNAPSHOT_HINT.search(s["column"])]
        date_col = (named or sorted(dates, key=lambda s: s["distinct"]))[0]["column"]
        entities = sorted(
            (
                s
                for c, s in zip(t.columns, stats[t.qualified], strict=True)
                if ENTITY_HINT.search(c.name)
                and c.family in ("number", "text")
                and 2 <= s["distinct"] < n
                and s["fill_pct"] >= 95
            ),
            key=lambda s: s["distinct"],
            reverse=True,
        )
        names: list[str] = []
        for s in entities:  # ITEM and ITEMID are the same entity: keep one per distinct count
            if all(abs(s["distinct"] - _distinct(stats[t.qualified], o)) > 1 for o in names):
                names.append(s["column"])
            if len(names) == 2:
                break
        return t, date_col, names
    return None


def _distinct(stats: list[dict[str, Any]], column: str) -> int:
    return int(next(s["distinct"] for s in stats if s["column"] == column))


def cadence(dates: Sequence[date]) -> dict[str, Any]:
    """Gaps between snapshot dates, in runs, and where the step changes (weekly -> daily)."""
    if len(dates) < 2:
        return {"dates": len(dates)}
    steps = [(b - a).days for a, b in pairwise(dates)]
    runs: list[dict[str, Any]] = []
    for d, step in zip(dates[1:], steps, strict=False):
        if runs and runs[-1]["step_days"] == step:
            runs[-1]["to"] = d.isoformat()
            runs[-1]["count"] += 1
        else:
            runs.append({"step_days": step, "from": d.isoformat(), "to": d.isoformat(), "count": 1})
    usual = max(set(steps), key=steps.count)
    return {
        "dates": len(dates),
        "first": dates[0].isoformat(),
        "last": dates[-1].isoformat(),
        "usual_step_days": usual,
        "runs": runs,
    }


def breaks(
    series: Sequence[dict[str, Any]], key: str, threshold: float = 0.3
) -> list[dict[str, Any]]:
    """Consecutive dates where a count moves by more than threshold (a pipeline or real break)."""
    out = []
    for prev, cur in pairwise(series):
        a, b = float(prev[key] or 0), float(cur[key] or 0)
        if a and abs(b - a) / a > threshold:
            out.append({"from": prev["date"], "to": cur["date"], key: [int(a), int(b)]})
    return out


def _iso(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)[:10]


# ---------------------------------------------------------------------------------------------
# Checks on agent proposals
# ---------------------------------------------------------------------------------------------


@dataclass
class CheckReport:
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def as_dict(self) -> dict[str, Any]:
        return {"ok": self.ok, "errors": self.errors, "warnings": self.warnings}


# ---------------------------------------------------------------------------------------------
# Measured facts for the data guide (patterns from NVIDIA Auto Ontology, rebuilt as aggregates)
#
# The analyst used to name keys and joins from names and counts alone. These functions measure
# them instead, so the guide can say "confirmed by the data" and the mapper joins only what holds:
#   - a column is a KEY CANDIDATE when its distinct count equals its non-null count;
#   - a JOIN is CONFIRMED when at least `min_overlap_pct` of the distinct values on the many side
#     exist on the key side (one aggregate query, no value leaves the warehouse);
#   - TWIN tables share (almost) the same column names: copies, versions, back-fills.
# ---------------------------------------------------------------------------------------------

GENERIC_TOKENS = frozenset(
    {"id", "key", "code", "no", "num", "number", "ref", "sk", "pk", "fk", "dim", "fact", "gold",
     "silver", "bronze", "dw", "stg", "raw", "tbl", "v"}
)  # fmt: skip
TWIN_MIN_JACCARD = 0.8
TWIN_MIN_COLUMNS = 3
_CAMEL = re.compile(r"(?<=[a-z0-9])(?=[A-Z])")


def name_tokens(name: str) -> frozenset[str]:
    """Lower-case words of a table or column name, plurals folded, generic words dropped."""
    words = re.split(r"[^a-z0-9]+", _CAMEL.sub("_", name).lower())
    folded = [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in words if w]
    return frozenset(w for w in folded if w not in GENERIC_TOKENS)


def _nonnull(table: dict[str, Any], stat: dict[str, Any]) -> int:
    return round(int(table.get("rows") or 0) * float(stat.get("fill_pct") or 0) / 100)


def key_candidates(tables: Sequence[dict[str, Any]]) -> dict[str, list[str]]:
    """TABLE -> columns whose values never repeat (distinct count equals non-null count)."""
    out: dict[str, list[str]] = {}
    for t in tables:
        cols = [
            s["column"]
            for s in t["columns"]
            if (nn := _nonnull(t, s)) >= 2 and int(s.get("distinct") or 0) >= nn
        ]
        if cols:
            out[t["table"]] = cols
    return out


def table_twins(tables: Sequence[dict[str, Any]], limit: int = 20) -> list[dict[str, Any]]:
    """Pairs of tables whose column names overlap by TWIN_MIN_JACCARD or more."""
    shaped = [(t, frozenset(s["column"].upper() for s in t["columns"])) for t in tables]
    found: list[dict[str, Any]] = []
    for i, (a, ca) in enumerate(shaped):
        for b, cb in shaped[i + 1 :]:
            if min(len(ca), len(cb)) < TWIN_MIN_COLUMNS:
                continue
            jac = len(ca & cb) / len(ca | cb)
            if jac >= TWIN_MIN_JACCARD:
                found.append(
                    {"tables": [a["table"], b["table"]], "shared_columns": len(ca & cb),
                     "overlap_pct": round(100 * jac, 1), "rows": [a["rows"], b["rows"]]}
                )  # fmt: skip
    return sorted(found, key=lambda f: -f["overlap_pct"])[:limit]


@dataclass(frozen=True)
class JoinCandidate:
    source: str  # SCHEMA.TABLE.COLUMN (the many side)
    target: str  # SCHEMA.TABLE.COLUMN (the key side)
    score: int
    cast_text: bool  # one side is a number and the other text: compare as text

    def as_dict(self) -> dict[str, Any]:
        return {"source": self.source, "target": self.target, "name_match": self.score}


def _stat_family(stat: dict[str, Any]) -> str:
    return type_family(stat["type"])


def join_candidates(
    tables: Sequence[dict[str, Any]], keys: dict[str, list[str]], budget: int
) -> list[JoinCandidate]:
    """Column pairs worth testing: a key column elsewhere whose name matches, best first.
    The budget caps the number of warehouse queries (their `DB_PROBE_MAX_CALLS` idea)."""
    by_table = {t["table"]: t for t in tables}
    found: list[JoinCandidate] = []
    for tb_name, key_cols in keys.items():
        tb = by_table[tb_name]
        tb_tokens = name_tokens(tb_name.split(".")[-1])
        stats_b = {s["column"]: s for s in tb["columns"]}
        for kc in key_cols:
            sb = stats_b[kc]
            fam_b = _stat_family(sb)
            if fam_b not in ("number", "text"):
                continue
            kc_tokens = name_tokens(kc)
            for ta in tables:
                if ta["table"] == tb_name:
                    continue
                for sa in ta["columns"]:
                    fam_a = _stat_family(sa)
                    if (
                        fam_a not in ("number", "text")
                        or int(sa.get("distinct") or 0) < 2
                        or float(sa.get("fill_pct") or 0) < 1
                    ):
                        continue
                    a_tokens = name_tokens(sa["column"])
                    if sa["column"].upper() == kc.upper():
                        score = 3
                    elif a_tokens and (
                        a_tokens in (kc_tokens, kc_tokens | tb_tokens, kc_tokens - {"name"})
                    ):
                        score = 2
                    elif a_tokens and a_tokens <= tb_tokens:
                        score = 1
                    else:
                        continue
                    found.append(
                        JoinCandidate(f"{ta['table']}.{sa['column']}", f"{tb_name}.{kc}",
                                      score, fam_a != fam_b)
                    )  # fmt: skip
    # Up to two keys per source column, strongest name match first, fact-sized tables first.
    rows = {t["table"]: int(t.get("rows") or 0) for t in tables}
    found.sort(key=lambda c: (-c.score, -rows.get(c.source.rsplit(".", 1)[0], 0), c.source))
    per_source: dict[str, int] = {}
    picked: list[JoinCandidate] = []
    for c in found:
        if per_source.get(c.source, 0) >= 2:  # the id and the name key of one dimension
            continue
        per_source[c.source] = per_source.get(c.source, 0) + 1
        picked.append(c)
        if len(picked) >= budget:
            break
    return picked


def join_probe_sql(database: str, c: JoinCandidate) -> str:
    """One row: distinct values on the source side and how many of them the key side holds."""
    db = check_ident(database)

    def parts(ref: str) -> tuple[str, str]:
        schema, table, column = ref.split(".")
        return f"{db}.{check_ident(schema)}.{check_ident(table)}", check_ident(column)

    (ta, ca), (tb, cb) = parts(c.source), parts(c.target)
    ea, eb = (f"cast({ca} as varchar)", f"cast({cb} as varchar)") if c.cast_text else (ca, cb)
    return (
        "select count(*) as n_values, count(b.k) as matched from "
        f"(select distinct {ea} as k from {ta} where {ca} is not null) as a "
        f"left join (select {eb} as k from {tb} where {cb} is not null group by 1) as b "
        "on a.k = b.k"
    )


def judge_join(row: dict[str, Any], min_overlap_pct: float) -> dict[str, Any]:
    values = int(row.get("n_values") or 0)
    matched = int(row.get("matched") or 0)
    share = pct(matched, values)
    return {"values": values, "matched_pct": share, "orphan_values": values - matched,
            "confirmed": values > 0 and share >= min_overlap_pct}  # fmt: skip


def known_columns(profile: dict[str, Any]) -> dict[str, set[str]]:
    """SCHEMA.TABLE -> its column names (upper case)."""
    return {
        t["table"].upper(): {c["column"].upper() for c in t["columns"]} for t in profile["tables"]
    }


def check_discovery(out: dict[str, Any], profile: dict[str, Any]) -> CheckReport:
    report = CheckReport()
    cols = known_columns(profile)
    tested = {(j["source"].upper(), j["target"].upper()): j for j in profile.get("joins", [])}
    for t in out.get("tables", []):
        name = t["table"].upper()
        if name not in cols:
            report.errors.append(f"table {t['table']} is not in the warehouse")
            continue
        for k in t.get("key_columns", []):
            if k.split(".")[-1].upper() not in cols[name]:
                report.errors.append(f"{t['table']}.{k} does not exist")
        for j in t.get("joins", []):
            ref = j["references_table"].upper()
            if ref not in cols:
                report.warnings.append(f"join to unknown table {j['references_table']}")
            elif j["references_column"].upper() not in cols[ref]:
                report.warnings.append(
                    f"join to unknown column {j['references_table']}.{j['references_column']}"
                )
            else:
                claim = (f"{name}.{j['column']}".upper(), f"{ref}.{j['references_column']}".upper())
                hit = tested.get(claim)
                target = f"{j['references_table']}.{j['references_column']}"
                label = f"{t['table']}.{j['column']} -> {target}"
                if hit and not hit.get("confirmed"):
                    report.warnings.append(
                        f"join {label} is not supported by the data: only {hit['matched_pct']:g}% "
                        "of its values are found on the key side"
                    )
                elif not hit and j.get("confidence") == "high":
                    report.warnings.append(
                        f"join {label} was claimed with high confidence but not tested"
                    )
    report.errors += _check_semantic_guides(out.get("semantic_views", []), profile)
    missing = set(FAMILIES) - {c["family"] for c in out.get("coverage", [])}
    if missing:
        report.warnings.append(f"no coverage verdict for {', '.join(sorted(missing))}")
    profiled = {t["table"].upper() for t in profile["tables"]}
    unguided = profiled - {t["table"].upper() for t in out.get("tables", [])}
    if unguided:
        report.warnings.append(f"tables not described: {', '.join(sorted(unguided))}")
    return report


def _check_semantic_guides(guides: list[dict[str, Any]], profile: dict[str, Any]) -> list[str]:
    """A semantic view guide may only name views, metrics and dimensions the profile lists."""
    known = {str(v["view"]).upper(): v for v in profile.get("semantic_views", [])}
    errors: list[str] = []
    for g in guides:
        v = known.get(str(g["view"]).upper())
        if v is None:
            errors.append(f"semantic view {g['view']} is not in the warehouse")
            continue
        names: dict[str, str] = {}
        for t in v["tables"]:
            for kind, key in (("metric", "metrics"), ("dimension", "dimensions")):
                for x in t[key]:  # TABLE.NAME, or the bare NAME (unambiguous enough in a view)
                    names[f"{t['table']}.{x['name']}".upper()] = kind
                    names.setdefault(str(x["name"]).upper(), kind)
        capped = any(t.get("dimension_count", 0) > len(t["dimensions"]) for t in v["tables"])
        for list_key, kind in (("key_metrics", "metric"), ("key_dimensions", "dimension")):
            for n in g.get(list_key, []):
                if names.get(str(n).upper()) != kind and not (kind == "dimension" and capped):
                    errors.append(f"{g['view']}: {n} is not a {kind} of the view")
        bad = [f for f in g.get("families", []) if f not in FAMILIES]
        if bad:
            errors.append(f"{g['view']}: unknown data families {', '.join(bad)}")
    return errors


def referenced_tables(sql: str) -> set[tuple[str, str, str]]:
    return {tuple(p.upper() for p in m.groups()) for m in QUALIFIED.finditer(sql)}  # type: ignore[misc]


def check_mapping_sql(
    archetype: str,
    fields: Iterable[str],
    proposal: dict[str, Any],
    database: str,
    profile: dict[str, Any],
) -> CheckReport:
    """Static checks before the SQL touches the warehouse."""
    report = CheckReport()
    sql = (proposal.get("source_sql") or "").strip().rstrip(";")
    if proposal.get("status") == "unmappable":
        return report
    if not sql:
        report.errors.append(f"{archetype}: no source_sql")
        return report
    if ";" in sql or not SINGLE_SELECT.match(sql) or WRITE_WORDS.search(sql):
        report.errors.append(f"{archetype}: source_sql must be one read-only SELECT")
    cols = known_columns(profile)
    for db, schema, table in referenced_tables(semantic.strip_views(sql)):
        if db != database.upper():
            report.errors.append(f"{archetype}: {db}.{schema}.{table} is outside {database}")
        elif f"{schema}.{table}" not in cols:
            report.errors.append(f"{archetype}: {schema}.{table} is not in the warehouse")
    report.errors += semantic.check_source(
        archetype, sql, database, profile.get("semantic_views", [])
    )
    named = {f["field"] for f in proposal.get("fields", [])}
    for f in fields:
        if f not in named:
            report.warnings.append(f"{archetype}: no reasoning given for field {f}")
        if not re.search(rf"\bas\s+{re.escape(f)}\b", sql, re.IGNORECASE) and not re.search(
            rf"[\s,.]{re.escape(f)}\s*(,|\bfrom\b)", sql, re.IGNORECASE
        ):
            report.warnings.append(f"{archetype}: no output column named {f} seen in the SQL")
    report.warnings += check_filter_values(archetype, sql, profile).warnings
    for f in proposal.get("fields", []):
        if f["confidence"] == "low":
            report.warnings.append(f"{archetype}.{f['field']}: low confidence ({f['reason']})")
    return report


def mapping_test_sql(source_sql: str, fields: Sequence[str], date_field: str | None) -> str:
    parts = ["count(*) as n_rows"] + [
        f"count({check_ident(f)}) as nn_{i}" for i, f in enumerate(fields)
    ]
    if date_field:
        d = check_ident(date_field)
        parts += [f"min({d}) as min_date", f"max({d}) as max_date", f"count(distinct {d}) as dates"]
    return f"select {', '.join(parts)} from ({source_sql.strip().rstrip(';')}) as m"


def value_mix_sql(source_sql: str, column: str) -> str:
    col = check_ident(column)
    return (
        f"select {col} as value, count(*) as n from ({source_sql.strip().rstrip(';')}) as m "
        "group by 1 order by 2 desc limit 30"
    )


def kind_names_sql(source_sql: str) -> str:
    """Each location's name under its kind, for the client's "is this how you sort them?"."""
    return (
        "select location_kind as kind, location_name as name "
        f"from ({source_sql.strip().rstrip(';')}) as m group by 1, 2 order by 1, 2 limit 400"
    )


def judge_mapping_health(
    archetype: str,
    baseline: dict[str, Any] | None,
    now: dict[str, Any],
    live: CheckReport,
    rows_change_pct: float,
    fill_drop_pts: float,
) -> dict[str, Any]:
    """Compare a mapping today with how it looked when the team approved it.
    `fail` = it no longer works (no rows, refused by the warehouse, values outside the set);
    `warn` = the customer's data moved (row count, emptier fields, repeating keys)."""
    issues: list[str] = []
    status = "ok"
    if live.errors:
        status, issues = "fail", [e for e in live.errors]
    rows = int(now.get("rows") or 0)
    if baseline and status != "fail":
        before = int(baseline.get("rows") or 0)
        if before and abs(rows - before) * 100 > rows_change_pct * before:
            change = round(100 * (rows - before) / before, 1)
            issues.append(f"{archetype}: {rows} rows now, {before} when approved ({change:+g}%)")
            status = "warn"
        was = {f["field"]: f["fill_pct"] for f in baseline.get("fills") or []}
        for f in now.get("fills") or []:
            if f["field"] in was and was[f["field"]] - f["fill_pct"] >= fill_drop_pts:
                issues.append(
                    f"{archetype}.{f['field']} is {f['fill_pct']:g}% filled, {was[f['field']]:g}% "
                    "when approved"
                )
                status = "warn"
        g_now, g_was = now.get("grain") or {}, baseline.get("grain") or {}
        was_pct, now_pct = g_was.get("repeated_pct", 0), g_now.get("repeated_pct", 0)
        if g_now and now_pct - was_pct >= 1.0:
            issues.append(
                f"{archetype}: rows repeating their key went from {was_pct:g}% to {now_pct:g}%"
            )
            status = "warn"
    elif status != "fail":  # nothing to compare with: report what the live test warns about
        issues += live.warnings
        status = "warn" if live.warnings else status
    return {"archetype": archetype, "status": status, "issues": issues, "rows": rows}


def would_fire(
    threshold: float | None, higher_is_better: bool, latest: Sequence[float]
) -> int | None:
    """How many entities are past the alert level on today's values (None: trend only)."""
    if threshold is None:
        return None
    return sum(1 for v in latest if (v < threshold if higher_is_better else v > threshold))


def negatives_sql(source_sql: str, columns: Sequence[str]) -> str:
    parts = [
        f"sum(case when {check_ident(c)} < 0 then 1 else 0 end) as neg_{i}"
        for i, c in enumerate(columns)
    ]
    return f"select {', '.join(parts)} from ({source_sql.strip().rstrip(';')}) as m"


# The fields that identify one row of an archetype. A mapped source that repeats a key is almost
# always a join that fans out (two matching rows on the other side), which inflates every metric.
# Archetypes whose rows have no natural key (for example wholesale lines) are left out.
GRAIN: dict[str, tuple[str, ...]] = {
    "inventory_snapshot": ("snapshot_date", "item_id", "location_id"),
    "inventory_position": ("snapshot_date", "sku"),
    "purchase_order": ("po_id",),
    "purchase_order_line": ("po_id", "po_line_id"),
    "sales_line": ("sale_date", "channel", "location_code", "sku"),
}


def grain_sql(source_sql: str, grain: Sequence[str]) -> str:
    """One row: keys, rows, rows beyond the first per key, and the most rows on one key."""
    cols = ", ".join(check_ident(g) for g in grain)
    return (
        "select count(*) as n_keys, coalesce(sum(c), 0) as n_rows, "
        "coalesce(sum(case when c > 1 then c - 1 else 0 end), 0) as extra_rows, "
        "coalesce(max(c), 0) as max_per_key from ("
        f"select count(*) as c from ({source_sql.strip().rstrip(';')}) as m group by {cols}"
        ") as g"
    )


def judge_grain(
    archetype: str, grain: Sequence[str], row: dict[str, Any], tolerance_pct: float
) -> tuple[CheckReport, dict[str, Any]]:
    """Refuse a mapping whose rows repeat their key beyond the tolerance (a fan-out join)."""
    report = CheckReport()
    n_rows = int(row.get("n_rows") or 0)
    extra = int(row.get("extra_rows") or 0)
    worst = int(row.get("max_per_key") or 0)
    share = pct(extra, n_rows)
    entry = {"grain": list(grain), "repeated_rows": extra, "repeated_pct": share,
             "max_per_key": worst}  # fmt: skip
    key = ", ".join(grain)
    if n_rows and share > tolerance_pct:
        report.errors.append(
            f"{archetype}: {share:g}% of rows repeat their key ({key}), up to {worst} rows on one "
            "key. A join is probably matching more than one row on the other side."
        )
    elif extra:
        report.warnings.append(
            f"{archetype}: {extra} rows ({share:g}%) repeat their key ({key}); within tolerance."
        )
    return report, entry


EQUALS_LITERAL = re.compile(
    r"(?<![\w$.])(?:[A-Za-z_][\w$]*\.)?([A-Za-z_][\w$]*)\s*(?:=|<>|!=)\s*'((?:[^']|'')*)'"
)
IN_LITERALS = re.compile(
    r"(?<![\w$.])(?:[A-Za-z_][\w$]*\.)?([A-Za-z_][\w$]*)\s+(?:not\s+)?in\s*\(\s*('(?:[^']|'')*'"
    r"(?:\s*,\s*'(?:[^']|'')*')*)\s*\)",
    re.IGNORECASE,
)


def filter_literals(sql: str) -> list[tuple[str, str]]:
    """(column, literal) for every `col = 'x'`, `col <> 'x'` and `col in ('x', 'y')` in the SQL.
    A function around the column (`upper(col) = 'X'`) is left alone: the writer handled the case."""
    found = [(m.group(1), m.group(2).replace("''", "'")) for m in EQUALS_LITERAL.finditer(sql)]
    for m in IN_LITERALS.finditer(sql):
        for lit in re.findall(r"'((?:[^']|'')*)'", m.group(2)):
            found.append((m.group(1), lit.replace("''", "'")))
    return found


def check_filter_values(archetype: str, sql: str, profile: dict[str, Any]) -> CheckReport:
    """Compare the literals a mapping filters on with the codes the profile saw in that column.
    Costs no query: the profile already lists the values of every low-cardinality column."""
    report = CheckReport()
    seen: dict[str, set[str]] = {}
    complete: dict[str, bool] = {}
    for cat in profile.get("categories", []):
        col = cat["column"].upper()
        seen.setdefault(col, set()).update(
            str(v["value"]) for v in cat["values"] if v["value"] is not None
        )
        complete[col] = complete.get(col, True) and len(cat["values"]) <= MAX_CATEGORY_DISTINCT
    reported: set[tuple[str, str]] = set()
    for column, literal in filter_literals(sql):
        col = column.upper()
        if col not in seen or (col, literal) in reported or literal in seen[col]:
            continue
        reported.add((col, literal))
        loose = {v.strip().casefold(): v for v in seen[col]}
        close = loose.get(literal.strip().casefold())
        if close is not None:
            report.warnings.append(
                f"{archetype}: filter {column} = '{literal}' differs from '{close}' in the data "
                "(case or spaces); it will probably match nothing."
            )
        elif complete.get(col):
            shown = ", ".join(sorted(seen[col])[:8])
            report.warnings.append(
                f"{archetype}: filter {column} = '{literal}' is not one of the values seen in "
                f"{column} ({shown})."
            )
    return report


# Categorical archetype fields whose values must come from a fixed set.
ENUM_FIELDS: dict[str, tuple[str, ...]] = {
    "location_kind": ("store", "warehouse", "non_sellable", "other"),
}
QUANTITY_HINT = re.compile(r"(_units|_value|qty_)", re.IGNORECASE)


def judge_mapping_test(
    archetype: str,
    fields: Sequence[str],
    test: dict[str, Any],
    mixes: dict[str, list[dict[str, Any]]],
    negatives: dict[str, int],
    expected_null: set[str],
) -> tuple[CheckReport, list[dict[str, Any]]]:
    """Turn the live test of a mapping into errors, warnings and a per-field fill table."""
    report = CheckReport()
    n = int(test.get("n_rows") or 0)
    if n == 0:
        report.errors.append(f"{archetype}: the source returns no rows")
    fills = []
    for i, f in enumerate(fields):
        fill = pct(float(test.get(f"nn_{i}") or 0), n)
        fills.append({"field": f, "fill_pct": fill})
        if fill == 0 and f not in expected_null:
            report.warnings.append(f"{archetype}.{f} is always empty")
    for f, allowed in ENUM_FIELDS.items():
        if f in mixes:
            bad = [m["value"] for m in mixes[f] if m["value"] not in allowed]
            if bad:
                report.errors.append(f"{archetype}.{f} has values outside {allowed}: {bad[:5]}")
    for f, count in negatives.items():
        if count:
            report.warnings.append(f"{archetype}.{f} is negative on {count} rows")
    return report, fills


def check_org(out: dict[str, Any], archetypes: set[str]) -> CheckReport:
    report = CheckReport()
    roles = out.get("roles", [])
    refs = [r["ref"] for r in roles]
    if len(set(refs)) != len(refs):
        report.errors.append("role refs must be unique")
    roots = [r for r in roles if not r.get("parent_ref")]
    if len(roots) != 1:
        report.errors.append(f"exactly one root role is needed, got {len(roots)}")
    elif roots[0]["archetype"] != "ceo":
        report.errors.append("the root role must use the ceo archetype")
    seen: set[str] = set()
    depts = {d["name"] for d in out.get("departments", [])}
    for r in roles:
        if r["archetype"] not in archetypes:
            report.errors.append(f"{r['ref']}: unknown archetype {r['archetype']}")
        if r.get("parent_ref") and r["parent_ref"] not in seen:
            report.errors.append(f"{r['ref']}: parent {r['parent_ref']} must come first")
        if r.get("department") and r["department"] not in depts:
            report.errors.append(f"{r['ref']}: unknown department {r['department']}")
        if not IDENT.match(r["ref"]):
            report.errors.append(f"{r['ref']}: refs are snake_case identifiers")
        seen.add(r["ref"])
    for d in out.get("departments", []):
        if d["playbook"] not in PLAYBOOKS:
            report.errors.append(f"{d['name']}: unknown playbook {d['playbook']}")
        if d["head_ref"] not in refs:
            report.errors.append(f"{d['name']}: head {d['head_ref']} is not a role")
    if not 3 <= len(roles) <= 12:
        report.warnings.append(f"{len(roles)} roles; 3 to 12 is the usual range")
    return report


@dataclass(frozen=True)
class TemplateInfo:
    key: str
    version: int
    archetypes: frozenset[str]
    params: dict[str, dict[str, Any]]
    exposure: str | None = None  # what the template's driver multiplies the gap by


# Exposures that are amounts of money: a gap in percentage points times one of these needs a
# per-point rate (a 35% margin is 0.0035 per point per CAD), or the impact is 100 times too big.
MONEY_EXPOSURES = frozenset(
    {"company_weekly_net_sales", "stores_stock_value", "weekly_gross_sales", "weekly_net_sales"}
)
MAX_POINT_RATE = 0.02


def check_metrics(
    out: dict[str, Any],
    templates: dict[str, TemplateInfo],
    mapped: set[str],
    role_refs: set[str],
) -> CheckReport:
    report = CheckReport()
    keys: set[str] = set()
    for m in out.get("metrics", []):
        tpl = templates.get(m["template"])
        if m["key"] in keys or not IDENT.match(m["key"]):
            report.errors.append(f"metric key {m['key']} is invalid or repeated")
        keys.add(m["key"])
        if tpl is None:
            report.errors.append(f"{m['key']}: unknown template {m['template']}")
            continue
        if (
            tpl.exposure in MONEY_EXPOSURES
            and re.search(r"point|%", str(m.get("unit", "")), re.IGNORECASE)
            and float(m["unit_value"]) > MAX_POINT_RATE
        ):
            report.errors.append(
                f"{m['key']}: unit_value {m['unit_value']:g} is too big for a percentage-point "
                f"metric on a money base ({tpl.exposure}). Use the rate per point per CAD, for "
                "example a 35% margin is 0.0035, so the impact is not 100 times too large"
            )
        if m["template_version"] != tpl.version:
            report.warnings.append(f"{m['key']}: template version set to {tpl.version}")
        if not tpl.archetypes <= mapped:
            report.errors.append(
                f"{m['key']}: needs {', '.join(sorted(tpl.archetypes - mapped))} mapped"
            )
        if not 0 < m["unit_value"] <= 100000:
            report.errors.append(f"{m['key']}: unit_value {m['unit_value']} out of range")
        for p in m.get("params", []):
            spec = tpl.params.get(p["name"])
            if spec is None:
                report.errors.append(f"{m['key']}: template has no parameter {p['name']}")
            elif not spec.get("minimum", -math.inf) <= p["value"] <= spec.get("maximum", math.inf):
                report.errors.append(f"{m['key']}: {p['name']}={p['value']} outside its bounds")
        if not m.get("attach"):
            report.errors.append(f"{m['key']}: no owner role")
        if len(m.get("attach", [])) > 1:
            report.errors.append(
                f"{m['key']}: one owner only (managers see it through roll-ups); "
                f"it is attached to {len(m['attach'])} roles and would make duplicate cards"
            )
        for a in m.get("attach", []):
            if a["role_ref"] not in role_refs:
                report.errors.append(f"{m['key']}: unknown role {a['role_ref']}")
            if not 0.1 <= a["weight"] <= 3:
                report.errors.append(f"{m['key']}: weight {a['weight']} outside 0.1-3")
            t = a["threshold"]
            if t["kind"] == "percentile" and not 50 <= t["value"] <= 99:
                report.errors.append(f"{m['key']}: percentile {t['value']} outside 50-99")
            if t["kind"] == "median_multiple" and not 1 < t["value"] <= 10:
                report.errors.append(f"{m['key']}: median multiple {t['value']} outside 1-10")
    return report


def threshold_from_rule(kind: str, value: float, latest: Sequence[float]) -> float | None:
    """Turn the agent's rule into a number from the dry run. Code, not the model, sees amounts."""
    xs = sorted(x for x in latest if x is not None)
    if kind == "none" or not xs:
        return None
    if kind == "percentile":
        k = (len(xs) - 1) * value / 100
        lo, hi = math.floor(k), math.ceil(k)
        result = xs[lo] + (xs[hi] - xs[lo]) * (k - lo)
    else:
        mid = len(xs) // 2
        median = xs[mid] if len(xs) % 2 else (xs[mid - 1] + xs[mid]) / 2
        result = median * value
    return round(result, 2) if result else None


def dry_run_shape(rows: Sequence[dict[str, Any]], truncated: bool, row_cap: int) -> dict[str, Any]:
    """What the metric advisor may see of a template's output: counts and ratios, no amounts."""
    by_entity: dict[str, list[float]] = {}
    weeks: set[str] = set()
    for r in rows:
        by_entity.setdefault(str(r["entity"]), []).append(float(r["value"] or 0))
        weeks.add(str(r["period_start"]))
    latest = [v[-1] for v in by_entity.values() if v]
    positive = [x for x in latest if x > 0]
    spread = None
    if len(positive) >= 2:
        s = sorted(positive)
        spread = round(s[int(0.9 * (len(s) - 1))] / s[len(s) // 2], 2) if s[len(s) // 2] else None
    history = sorted(len(v) for v in by_entity.values())
    return {
        "entities": len(by_entity),
        "weeks": len(weeks),
        "rows": len(rows),
        "truncated": truncated,
        "row_cap": row_cap,
        "weeks_per_entity_min": history[0] if history else 0,
        "weeks_per_entity_median": history[len(history) // 2] if history else 0,
        "share_of_entities_above_zero": pct(len(positive), len(latest)) if latest else 0,
        "p90_over_median_latest": spread,
    }


def check_rules(out: dict[str, Any]) -> tuple[CheckReport, dict[str, Any]]:
    """Validate each change against SCHEMA; returns the coerced values."""
    report = CheckReport()
    clean: dict[str, Any] = {}
    blocked_groups = {"access"}
    blocked_keys = {"llm_log_retention_days"}
    for c in out.get("changes", []):
        key = c["key"]
        if key not in SCHEMA:
            report.errors.append(f"unknown setting {key}")
            continue
        if SCHEMA[key].group in blocked_groups or key in blocked_keys:
            report.errors.append(f"{key} cannot be changed by onboarding")
            continue
        try:
            clean[key] = coerce(key, c["value"])
        except ValueError as exc:
            report.errors.append(str(exc))
    if len(out.get("changes", [])) > 6:
        report.warnings.append("more than 6 changes; review each one")
    return report, clean


def rows_needed(entities: int, weeks: int) -> int:
    return entities * weeks


# Which mapped data shapes carry each standard data family (for the measured coverage verdict).
FAMILY_SHAPES: dict[str, tuple[str, ...]] = {
    "sales": ("sales_line",),
    "inventory": ("inventory_snapshot", "inventory_position"),
    "purchase_orders": ("purchase_order", "purchase_order_line"),
}


def refresh_coverage(
    coverage: Sequence[dict[str, Any]], measured: dict[str, dict[str, Any]], approved: set[str]
) -> list[dict[str, Any]]:
    """Update the data guide's verdicts with what mapping measured on the real data.

    A family whose every shape is approved and returned rows is present; some shapes approved
    is at least partial. Measured text is added to the evidence. Other families are unchanged."""
    out: list[dict[str, Any]] = []
    for c in coverage:
        shapes = FAMILY_SHAPES.get(c["family"], ())
        ok = [n for n in shapes if n in approved and (measured.get(n) or {}).get("rows")]
        if not ok:
            out.append(dict(c))
            continue
        facts = "; ".join(
            f"{n}: {measured[n]['rows']:,} rows"
            + (f", {measured[n]['first_date']} to {measured[n]['last_date']}"
               if measured[n].get("first_date") else "")
            for n in ok
        )  # fmt: skip
        status = "present" if len(ok) == len(shapes) else "partial"
        if c["status"] == "present":
            status = "present"
        out.append({**c, "status": status, "evidence": f"{c['evidence']} Measured: {facts}."})
    return out


# Item codes must line up across the shapes that carry them, or no metric can join them.
SKU_WINDOW: dict[str, tuple[str, int]] = {  # shape -> (date field, days of history compared)
    "sales_line": ("sale_date", 90),
    "inventory_position": ("snapshot_date", 30),
    "purchase_order_line": ("ordered_at", 365),
}


def sku_codes_sql(source_sql: str, shape: str) -> str:
    """The distinct item codes of one mapping over its recent window (upper-cased, trimmed)."""
    date_field, days = SKU_WINDOW[shape]
    check_ident(date_field)
    return (
        f"select distinct upper(trim(sku::varchar)) as sku from ({source_sql}) "
        f"where sku is not null and {date_field} >= dateadd('day', -{int(days)}, current_date())"
    )


def sku_overlap_sql(sales_codes: str, other_codes: str) -> str:
    return (
        f"with a as ({sales_codes}), b as ({other_codes}) "
        "select (select count(*) from a) as sold, (select count(*) from b) as other, "
        "(select count(*) from a join b using (sku)) as shared"
    )


def judge_sku_overlap(
    shape: str, row: dict[str, Any], min_pct: float
) -> tuple[CheckReport, dict[str, Any]]:
    """Refuse a mapping whose item codes mostly differ from the sales mapping's."""
    report = CheckReport()
    sold, shared = int(row.get("sold") or 0), int(row.get("shared") or 0)
    entry = {"sold_codes": sold, "shared_codes": shared, "pct_of_sold": pct(shared, sold)}
    if sold and entry["pct_of_sold"] < min_pct:
        report.errors.append(
            f"{shape}: only {entry['pct_of_sold']:g}% of the item codes sold recently appear in "
            f"this mapping's sku ({shared} of {sold}). The two use different item codes, so no "
            "metric can join stock or purchases to sales. Map sku from a field that matches the "
            "sales sku (a semantic view may expose it)."
        )
    return report, entry
