"""A benchmark for Discovery: obvious things the AI chose itself, checked against the profile.

The profile is what was measured. For some choices the right answer is obvious and code can work
it out without any AI: the table of a view that holds the most measures is its main table, a table
named SALES_... with measures feeds the sales area, a measure the AI lists must exist in the view,
the data arrives weekly or daily. If the AI gets these wrong it did not read its context properly,
and nothing it says about the harder things can be trusted. If it gets them right, that is evidence
it did.

Pure. Each probe is {id, group, title, expected, found, status, detail}; status is pass, fail or
skip (a probe that cannot be checked is skipped, never failed). No data values are read.
"""

import re
from typing import Any

from app.domain.discovery_cards import _family

# A table name that says which area it belongs to (the guide audit's hints, plus the rest).
AREA_HINTS: dict[str, re.Pattern[str]] = {
    "sales": re.compile(r"SALES|CASHSALE|INVOICE|ORDER_LINE", re.I),
    "purchase_orders": re.compile(r"PURCHASE", re.I),
    "inventory": re.compile(r"INVENTORY|ITEM_?LOCATION|STOCK", re.I),
    "transfers": re.compile(r"TRANSFER", re.I),
    "receipts": re.compile(r"RECEIPT", re.I),
    "returns": re.compile(r"RETURN|REFUND", re.I),
}
# Areas the AI must rate if the profile has a table named for them.
COVERAGE_HINTS: dict[str, re.Pattern[str]] = {
    **AREA_HINTS,
    "vendors": re.compile(r"VENDOR|SUPPLIER", re.I),
    "customers": re.compile(r"CUSTOMER", re.I),
    "calendar": re.compile(r"CALENDAR", re.I),
}
# Probes that, failed, mean the AI made something up and cannot be trusted with its context.
CRITICAL = {"tables_exist", "measures_exist", "joins_fit", "issue_columns_exist"}


def _short(name: Any) -> str:
    return str(name).split(".")[-1].upper()


def _probe(
    pid: str, group: str, title: str, expected: str, found: str, status: str, detail: str = ""
) -> dict[str, str]:
    return {
        "id": pid,
        "group": group,
        "title": title,
        "expected": expected,
        "found": found,
        "status": status,
        "detail": detail,
    }


def _views(profile: dict[str, Any]) -> list[dict[str, Any]]:
    return list(profile.get("semantic_views", []))


def _view_tables(view: dict[str, Any]) -> list[dict[str, Any]]:
    return list(view.get("tables", []))


def _guide_of(out: dict[str, Any], view: str) -> dict[str, Any] | None:
    for g in out.get("semantic_views", []):
        if str(g.get("view", "")).upper() == view.upper():
            return dict(g)
    return None


def _names(items: list[dict[str, Any]]) -> set[str]:
    return {str(i.get("name", "")).upper() for i in items}


def _picked(entry: Any) -> tuple[str | None, str]:
    """'TABLE.NAME' as the AI wrote it -> (TABLE or None, NAME), upper case."""
    parts = str(entry).upper().split(".")
    return (parts[-2] if len(parts) > 1 else None), parts[-1]


# ---- the probes ------------------------------------------------------------------------------


def _main_tables(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    probes = []
    for v in _views(profile):
        facts = sorted(_view_tables(v), key=lambda t: -len(t.get("metrics", [])))
        if not facts or not facts[0].get("metrics"):
            continue
        main = str(facts[0]["table"]).upper()
        guide = _guide_of(out, str(v["view"]))
        title = f"The main table of {_short(v['view'])}"
        expected = f"{main} (it holds the most measures: {len(facts[0]['metrics'])})"
        if guide is None:
            probes.append(
                _probe(
                    f"main:{v['view']}",
                    "Tables",
                    title,
                    expected,
                    "the view is not described",
                    "fail",
                )
            )
            continue
        tables = {_picked(m)[0] for m in guide.get("key_metrics", [])}
        named = (
            main in str(guide.get("grain", "")).upper()
            or main in str(guide.get("purpose", "")).upper()
        )
        ok = main in tables or named
        probes.append(
            _probe(
                f"main:{v['view']}",
                "Tables",
                title,
                expected,
                "named it" if ok else "did not name it among its key measures",
                "pass" if ok else "fail",
            )
        )
    return probes


def _picks_exist(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    """The measures and fields the AI lists for each view must be in that view."""
    probes = []
    for v in _views(profile):
        guide = _guide_of(out, str(v["view"]))
        if guide is None:
            continue
        tables = {str(t["table"]).upper(): t for t in _view_tables(v)}
        for key, field, label in (
            ("key_metrics", "metrics", "measures"),
            ("key_dimensions", "dimensions", "fields"),
        ):
            wrong, shown = [], 0
            for entry in guide.get(key, []):
                table, name = _picked(entry)
                scope = (
                    [tables[table]]
                    if table in tables
                    else list(tables.values())
                    if table is None
                    else []
                )
                if table is not None and table not in tables:
                    wrong.append(f"{entry} (no such table in the view)")
                    continue
                if field == "dimensions" and any(
                    t.get("dimension_count", 0) > len(t.get("dimensions", [])) for t in scope
                ):
                    continue  # the field list was shortened: a field we cannot see may exist
                shown += 1
                if not any(name in _names(t.get(field, [])) for t in scope):
                    wrong.append(str(entry))
            pid = "measures_exist" if field == "metrics" else "fields_exist"
            title = f"The {label} it lists for {_short(v['view'])} are real"
            if not guide.get(key):
                continue
            probes.append(
                _probe(
                    f"{pid}:{v['view']}",
                    "Picks",
                    title,
                    f"every listed {label[:-1]} is in the view",
                    "all real" if not wrong else "not in the view: " + ", ".join(wrong[:4]),
                    "pass" if not wrong else "fail",
                )
            )
    return probes


def _families(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    """A table named for an area that holds measures: its view should feed that area."""
    probes = []
    for v in _views(profile):
        guide = _guide_of(out, str(v["view"]))
        if guide is None:
            continue
        wanted = {
            area
            for t in _view_tables(v)
            if t.get("metrics")
            for area, hint in AREA_HINTS.items()
            if hint.search(str(t["table"]))
        }
        have = {str(f).lower() for f in guide.get("families", [])}
        for area in sorted(wanted):
            ok = area in have
            probes.append(
                _probe(
                    f"family:{v['view']}:{area}",
                    "Areas",
                    f"{_short(v['view'])} feeds {area.replace('_', ' ')}",
                    f"{area.replace('_', ' ')} (a table named for it holds measures)",
                    "listed" if ok else "not listed",
                    "pass" if ok else "fail",
                )
            )
        if any(t.get("metrics") for t in _view_tables(v)):
            ref = guide.get("use_for") == "reference_only"
            probes.append(
                _probe(
                    f"use:{v['view']}",
                    "Areas",
                    f"{_short(v['view'])} is used as a source",
                    "a view that holds measures is a source, not only a reference",
                    "reference only" if ref else "a source",
                    "fail" if ref else "pass",
                )
            )
    return probes


def _coverage(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    names = [_short(t["table"]) for v in _views(profile) for t in _view_tables(v)] + [
        _short(t["table"]) for t in profile.get("tables", [])
    ]
    probes = []
    for c in out.get("coverage", []):
        area = str(c.get("family", ""))
        hint = COVERAGE_HINTS.get(area)
        if hint is None or c.get("status") != "missing":
            continue
        found = sorted({n for n in names if hint.search(n)})
        ok = not found
        probes.append(
            _probe(
                f"missing:{area}",
                "Areas",
                f"'{area.replace('_', ' ')}' is really missing",
                "no table named for it",
                "none found" if ok else "but the profile has " + ", ".join(found[:3]),
                "pass" if ok else "fail",
            )
        )
    return probes


def _tables(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    probes: list[dict[str, str]] = []
    prof = {str(t["table"]).upper(): t for t in profile.get("tables", [])}
    if not prof:
        return probes
    made_up = [t["table"] for t in out.get("tables", []) if str(t["table"]).upper() not in prof]
    probes.append(
        _probe(
            "tables_exist",
            "Picks",
            "Every table it describes exists",
            "only tables of the scan",
            "all real" if not made_up else "not in the scan: " + ", ".join(map(str, made_up[:4])),
            "pass" if not made_up else "fail",
        )
    )
    wrong = []
    for t in out.get("tables", []):
        name = _short(t["table"])
        kind = t.get("kind")
        if name.startswith("DIM_") and kind == "fact":
            wrong.append(f"{name} is a lookup table but was called a fact table")
        elif name.startswith("FACT_") and kind in ("dimension", "lookup"):
            wrong.append(f"{name} is a fact table but was called a {kind}")
    probes.append(
        _probe(
            "kinds",
            "Tables",
            "Table roles match their names",
            "DIM_ tables are lookups, FACT_ tables hold the rows",
            "all match" if not wrong else "; ".join(wrong[:3]),
            "pass" if not wrong else "fail",
        )
    )
    bad_keys = []
    for t in out.get("tables", []):
        cols = _names(
            [
                {"name": c.get("column")}
                for c in prof.get(str(t["table"]).upper(), {}).get("columns", [])
            ]
        )
        if not cols:
            continue
        bad_keys += [
            f"{_short(t['table'])}.{k}"
            for k in t.get("key_columns", [])
            if str(k).upper() not in cols
        ]
    probes.append(
        _probe(
            "keys_exist",
            "Picks",
            "The key columns it names exist",
            "every key column is a column of its table",
            "all real" if not bad_keys else "not columns: " + ", ".join(bad_keys[:4]),
            "pass" if not bad_keys else "fail",
        )
    )
    return probes


def _joins(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    prof = {str(t["table"]).upper(): t for t in profile.get("tables", [])}
    checked, bad = 0, []

    def kind_of(table: str, column: str) -> Any:
        for c in prof.get(table.upper(), {}).get("columns", []):
            if str(c.get("column", "")).upper() == column.upper():
                return c.get("type")
        return None

    for t in out.get("tables", []):
        for j in t.get("joins", []):
            ref = next((n for n in prof if _short(n) == _short(j["references_table"])), None)
            here = str(t["table"]).upper()
            if here not in prof or ref is None:
                continue
            a, b = kind_of(here, j["column"]), kind_of(ref, j["references_column"])
            if a is None or b is None:
                bad.append(
                    f"{_short(here)}.{j['column']} to {_short(ref)}.{j['references_column']}"
                    " (no such column)"
                )
                checked += 1
                continue
            checked += 1
            fa, fb = _family(a), _family(b)
            if "other" not in (fa, fb) and fa != fb:
                bad.append(
                    f"{_short(here)}.{j['column']} is {fa} but "
                    f"{_short(ref)}.{j['references_column']} is {fb}"
                )
    if not checked:
        return []
    return [
        _probe(
            "joins_fit",
            "Picks",
            "The relationships it picked can hold",
            "both columns exist and have the same kind of value",
            "all fit" if not bad else "; ".join(bad[:3]),
            "pass" if not bad else "fail",
        )
    ]


def _cadence(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    cadence = (profile.get("time_profile") or {}).get("cadence") or []
    runs = cadence.get("runs", []) if isinstance(cadence, dict) else cadence
    if not runs:
        return []
    by_step: dict[int, int] = {}
    for r in runs:
        by_step[int(r.get("step_days", 0))] = by_step.get(int(r.get("step_days", 0)), 0) + int(
            r.get("count", 0)
        )
    step = max(by_step, key=lambda k: by_step[k])
    word = {1: "daily", 7: "weekly"}.get(step)
    if word is None:
        return []
    said = str(out.get("cadence", "")).lower()
    ok = (
        word in said or (word == "weekly" and "week" in said) or (word == "daily" and "day" in said)
    )
    return [
        _probe(
            "cadence",
            "Data",
            "How often the data arrives",
            f"{word} (most snapshots are {step} day{'s' if step != 1 else ''} apart)",
            "says so" if ok else f"says: {str(out.get('cadence', ''))[:80]}",
            "pass" if ok else "fail",
        )
    ]


def _issue_columns(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    known: set[str] = set()
    for t in profile.get("tables", []):
        for c in t.get("columns", []):
            known.add(f"{_short(t['table'])}.{str(c.get('column', '')).upper()}")
    for v in _views(profile):
        for t in _view_tables(v):
            for d in [*t.get("dimensions", []), *t.get("metrics", [])]:
                known.add(f"{_short(t['table'])}.{str(d.get('name', '')).upper()}")
    if not known:
        return []
    cited, wrong = 0, []
    for q in out.get("quality_issues", []):
        for col in q.get("columns", []):
            cited += 1
            parts = str(col).upper().split(".")
            if len(parts) >= 2 and f"{parts[-2]}.{parts[-1]}" not in known:
                wrong.append(str(col))
    if not cited:
        return []
    return [
        _probe(
            "issue_columns_exist",
            "Picks",
            "The columns named in its data problems exist",
            "every column named is in the scan",
            "all real" if not wrong else "not found: " + ", ".join(wrong[:4]),
            "pass" if not wrong else "fail",
        )
    ]


def _views_described(out: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, str]]:
    views = [str(v["view"]).upper() for v in _views(profile)]
    if not views:
        return []
    missing = [v for v in views if _guide_of(out, v) is None]
    return [
        _probe(
            "views_described",
            "Tables",
            "Every view of the customer is described",
            f"all {len(views)} views",
            "all described"
            if not missing
            else "left out: " + ", ".join(_short(m) for m in missing[:3]),
            "pass" if not missing else "fail",
        )
    ]


def grade(probes: list[dict[str, str]], critical_ids: set[str]) -> dict[str, Any]:
    """The verdict of a benchmark: skipped probes do not count; a failed critical probe (the AI
    made something up) makes the whole answer doubtful whatever the score."""
    graded = [p for p in probes if p["status"] != "skip"]
    passed = sum(1 for p in graded if p["status"] == "pass")
    failed = [p for p in graded if p["status"] == "fail"]
    critical = [p for p in failed if p["id"].split(":")[0] in critical_ids]
    score = round(100 * passed / len(graded)) if graded else 100
    verdict = "doubtful" if critical or score < 80 else "confirmed" if not failed else "mostly"
    return {
        "verdict": verdict,
        "score": score,
        "passed": passed,
        "total": len(graded),
        "failed": len(failed),
        "critical": len(critical),
        "probes": probes,
    }


def run(out: dict[str, Any], profile: dict[str, Any] | None) -> dict[str, Any] | None:
    """The benchmark of one discovery answer, or None when there is nothing to check it against."""
    if not profile or "summary" not in out:
        return None
    probes = [
        *_views_described(out, profile),
        *_tables(out, profile),
        *_main_tables(out, profile),
        *_picks_exist(out, profile),
        *_families(out, profile),
        *_coverage(out, profile),
        *_joins(out, profile),
        *_cadence(out, profile),
        *_issue_columns(out, profile),
    ]
    return grade(probes, CRITICAL)
