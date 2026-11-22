# ruff: noqa: E501
"""Plain-language facts for the client and code-computed checklists for our team (ADR 0029).

Checklists keep one check per call for readability (E501 off for this file).

The client never sees evidence, SQL or column names. Each approved step stores a summary
(onboarding_flow.summary_*); this module adds the counted facts, confidence words and presets
the client screens are built from, and the short checklist the team reviews first.

Pure: no I/O. Text for the client is composed in the web app from these facts (EN/FR); the team
checklist is English, like the rest of the console.
"""

import re
from datetime import date
from typing import Any

from app.domain.config import PRESETS, RulesConfig

# ---------------------------------------------------------------------------------------------
# Plain text: refuse anything that reads like a column name, SQL or a code value
# ---------------------------------------------------------------------------------------------

_SHOUT = re.compile(r"\b[A-Z]{5,}\b")
_PAREN = re.compile(r"\s*\([^)]*\)")


def is_plain(text: str) -> bool:
    """True when a sentence has no column names, code values or SQL."""
    if not text.strip():
        return False
    if _SHOUT.search(text):
        return False
    # Advice meant for our team ("ask the client") or raw ISO dates are not for the client.
    if re.search(r"\b(the client|baselines?|resample)\b|\d{4}-\d{2}-\d{2}", text, re.I):
        return False
    lowered = re.sub(r"\b[A-Z]{2,}_[A-Z0-9_]+", "X_X", text)
    return not re.search(
        r"X_X|\b[a-z]+_[a-z0-9_]+\b|[=<>]|\b(null|select|where|join|sql)\b", lowered, re.I
    )


def plain_or_none(text: str | None) -> str | None:
    """The text, the part after "to ..." when the start is technical, or None."""
    if not text:
        return None
    if is_plain(text):
        return text.strip()
    # "AUDIT_SOURCE = 'netsuite' to drop back-filled rows (codes x_y)" -> "Drop back-filled rows"
    m = re.search(r"\bto\s+(.+)$", text)
    if m:
        rest = _PAREN.sub("", m.group(1)).strip().rstrip(".")
        rest = re.split(r",\s*(so|because|which|assumes)\b", rest)[0].strip()
        if rest and is_plain(rest):
            return rest[0].upper() + rest[1:] + "."
    return None


# ---------------------------------------------------------------------------------------------
# Counted facts from the discovery profile
# ---------------------------------------------------------------------------------------------


def _months(first: str, last: str) -> int:
    a, b = date.fromisoformat(first[:10]), date.fromisoformat(last[:10])
    return max(1, (b.year - a.year) * 12 + (b.month - a.month) + (1 if b.day >= a.day else 0))


def data_facts(profile: dict[str, Any]) -> dict[str, Any]:
    """Items, locations and the period, counted from the main stock table's daily profile.

    Also finds the last big drop in reporting locations (closed stores, a changed extract) and
    when the data turned daily. Everything here is counted, never estimated.
    """
    tp = profile.get("time_profile") or {}
    rows = [r for r in tp.get("by_date", []) if r.get("date")]
    if not rows:
        return {}
    rows.sort(key=lambda r: r["date"])
    loc_key = next((k for k in rows[-1] if k.upper().startswith("LOCATION")), None)
    item_key = next((k for k in rows[-1] if k.upper().startswith("ITEM")), None)
    locs = [int(r.get(loc_key) or 0) for r in rows] if loc_key else []
    items = [int(r.get(item_key) or 0) for r in rows] if item_key else []
    drop = None
    for i in range(1, len(locs)):
        gone = locs[i - 1] - locs[i]
        if gone >= max(3, round(0.1 * locs[i - 1])):
            drop = {"date": rows[i]["date"], "before": locs[i - 1], "after": locs[i], "gone": gone}
    daily_since = None
    for i in range(len(rows) - 1, 0, -1):
        step = (date.fromisoformat(rows[i]["date"]) - date.fromisoformat(rows[i - 1]["date"])).days
        if step >= 6:
            daily_since = rows[i + 1]["date"] if i + 1 < len(rows) else None
            break
    first, last = rows[0]["date"], rows[-1]["date"]
    return {
        "items": max(items) if items else None,
        "locations": max(locs) if locs else None,
        "locations_now": locs[-1] if locs else None,
        "first_date": first,
        "last_date": last,
        "months": _months(first, last),
        "snapshots": len(rows),
        "location_drop": drop,
        "daily_since": daily_since if daily_since and daily_since != first else None,
    }


# ---------------------------------------------------------------------------------------------
# Confidence words: solid (use it), early (sharpens with time), not_yet (needs more data)
# ---------------------------------------------------------------------------------------------

LEVEL_OF_COVERAGE = {"present": "solid", "partial": "early", "missing": "not_yet"}
LEVEL_OF_SEVERITY = {"high": "limits", "medium": "noted", "low": "noted"}
# The three areas the client recognises; our families roll up into them.
AREAS: dict[str, tuple[str, ...]] = {
    "stock": ("inventory",),
    "sales": ("sales", "returns", "customers"),
    "purchasing": ("purchase_orders", "receipts", "vendors"),
}


def coverage_levels(coverage: list[dict[str, Any]]) -> list[dict[str, str]]:
    order = {"solid": 0, "early": 1, "not_yet": 2}
    out = [
        {"family": c["family"], "level": LEVEL_OF_COVERAGE.get(c["status"], "not_yet")}
        for c in coverage
        if c.get("family") != "calendar"
    ]
    return sorted(out, key=lambda x: order[x["level"]])


def areas(found: list[str], partial: list[str]) -> list[dict[str, str]]:
    """Stock / sales / purchasing: seen (any family found), partly seen, or not seen."""
    out = []
    for area, families in AREAS.items():
        if any(f in found for f in families):
            level = "seen"
        elif any(f in partial for f in families):
            level = "partly"
        else:
            level = "unseen"
        out.append({"area": area, "level": level})
    return out


def checked_counts(summary: dict[str, Any]) -> dict[str, int]:
    """'12 checks, 9 fine, 3 limited': coverage areas plus quality issues."""
    fine = len(summary.get("found", []))
    limited = len(summary.get("partial", [])) + len(summary.get("missing", []))
    issues = summary.get("issues", [])
    high = sum(1 for q in issues if q.get("severity") == "high")
    return {
        "total": fine + limited + len(issues),
        "fine": fine + len(issues) - high,
        "limited": limited + high,
    }


# ---------------------------------------------------------------------------------------------
# Presets for the alert rules: the client picks a feel, our team turns it into settings
# ---------------------------------------------------------------------------------------------


def preset_of(rules: RulesConfig) -> str | None:
    """The preset whose settings the workspace runs with now, if any."""
    for name, values in PRESETS.items():
        if all(getattr(rules, k) == v for k, v in values.items()):
            return name
    return None


def nearest_preset(rules: RulesConfig) -> str:
    """The preset closest to the money floor, for wording when the settings are custom."""
    floor = rules.min_signal_impact
    return min(PRESETS, key=lambda p: abs(float(PRESETS[p]["min_signal_impact"]) - floor))


# ---------------------------------------------------------------------------------------------
# "Your business, as Formada sees it": one panel that fills in as steps are approved
# ---------------------------------------------------------------------------------------------


def business(summaries: dict[str, dict[str, Any]]) -> dict[str, Any]:
    disc = summaries.get("discovery") or {}
    facts = disc.get("facts") or {}
    org = summaries.get("org") or {}
    met = summaries.get("metrics") or {}
    rules = summaries.get("rules") or {}
    datasets = (summaries.get("mapping") or {}).get("datasets", [])
    return {
        "data": {
            "items": facts.get("items"),
            "locations": facts.get("locations"),
            "first_date": facts.get("first_date"),
            "daily_since": facts.get("daily_since"),
            "linked": len(datasets),
        }
        if facts
        else None,
        "areas": areas(disc.get("found", []), disc.get("partial", [])) if disc else None,
        "people": {"count": len(org.get("roles", [])),
                   "titles": [r["title"] for r in org.get("roles", [])][:6]}
        if org else None,
        "watch": {"count": len(met.get("measures", [])),
                  "names": [m["name"] for m in met.get("measures", [])][:5]}
        if met else None,
        "hear": {"preset": rules.get("preset"), "floor": rules.get("floor"),
                 "cards": rules.get("cards_per_person"), "currency": met.get("currency", "CAD")}
        if rules.get("floor") is not None else None,
    }  # fmt: skip


# ---------------------------------------------------------------------------------------------
# Team checklists: review by exception. Each check is computed from the proposal and its tests.
# ---------------------------------------------------------------------------------------------


# Soft checks are worth a look but do not need a reason to approve past them.
SOFT = {("discovery", "questions"), ("mapping", "tests"), ("mapping", "fills"), ("metrics", "roles"),
        ("trial", "roles")}  # fmt: skip


def _c(key: str, ok: bool, title: str, detail: str, fix: str = "") -> dict[str, Any]:
    return {"key": key, "ok": ok, "title": title, "detail": detail, "fix": "" if ok else fix}


# Discovery and mapping show no checklist: the review screens carry the same facts, and approving
# does not ask for a reason.
NO_CHECKLIST = {"discovery", "mapping"}


def blocking(step: str, checks: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The failed checks that need a reason to approve past."""
    if step in NO_CHECKLIST:
        return []
    return [c for c in checks if not c["ok"] and (step, c["key"]) not in SOFT]


def checks_connect(conn: dict[str, Any] | None) -> list[dict[str, Any]]:
    if not conn:
        return [_c("tested", False, "Connection tested", "No connection yet.", "Add the "
                   "connection details, or use the mock warehouse locally.")]  # fmt: skip
    result = conn.get("test_result") or {}
    role = (conn.get("role_name") or "").lower()
    schemas = conn.get("schemas") or []
    return [
        _c("tested", conn.get("status") == "ok", "Test passes",
           "Last test succeeded." if conn.get("status") == "ok"
           else str(result.get("error") or "The last test failed."), "Fix the details and test again."),
        _c("read_only", "admin" not in role and "sysadmin" not in role, "Read-only role",
           f"Role {conn.get('role_name') or 'default'}.",
           "Use a role with SELECT grants only, never an admin role."),
        _c("schema", bool(schemas), "Schema found",
           ", ".join(schemas) if schemas else "No schema listed.", "List the schemas to read."),
    ]  # fmt: skip


def checks_discovery(out: dict[str, Any], threads: list[dict[str, Any]]) -> list[dict[str, Any]]:
    cov = out.get("coverage", [])
    issues = out.get("quality_issues", [])
    main = [t for t in out.get("tables", []) if t.get("kind") == "fact"]
    high = [q for q in issues if q.get("severity") == "high"]
    unhandled = [q for q in high if not (q.get("suggested_handling") or "").strip()]
    client_qs = [q for q in out.get("questions", []) if q.get("to") == "client"]
    asked = [t for t in threads if t.get("step") == "discovery" and t.get("raised_by") == "team"]
    return [
        _c("main_table", bool(main), "Main stock table found",
           ", ".join(t["table"] for t in main[:2]) or "No fact table identified.",
           "Run the analysis again with a note naming the stock table."),
        _c("coverage", bool(cov) and all(c.get("status") for c in cov), "Coverage known for every area",
           f"{sum(c['status'] == 'present' for c in cov)} found, "
           f"{sum(c['status'] == 'partial' for c in cov)} partial, "
           f"{sum(c['status'] == 'missing' for c in cov)} missing.", "Run the analysis again."),
        _c("issues", not unhandled, "High issues have a handling",
           f"{len(high)} high issue(s), all with a handling." if not unhandled
           else f"{len(unhandled)} high issue(s) without a handling: "
           + "; ".join(q["title"] for q in unhandled[:3]),
           "Add a note on how to handle them and run the analysis again."),
        _c("questions", not client_qs or bool(asked), "Questions for the client sent",
           f"{len(client_qs)} suggested, {len(asked)} sent." if client_qs else "None needed.",
           "Send the important ones from the Questions panel (one at a time works best)."),
    ]  # fmt: skip


def checks_mapping(out: dict[str, Any], checks: dict[str, Any]) -> list[dict[str, Any]]:
    by = checks.get("archetypes", {})
    mapped = [a for a in out.get("archetypes", []) if a.get("status") != "unmappable"]
    failing = [a["archetype"] for a in mapped if not by.get(a["archetype"], {}).get("ok")]
    # In the review lab the queries are not run, so there is no row count to judge.
    not_run = [a["archetype"] for a in mapped if by.get(a["archetype"], {}).get("lab_not_run")]
    rows = {a["archetype"]: by.get(a["archetype"], {}).get("rows") or 0
            for a in mapped if a["archetype"] not in failing and a["archetype"] not in not_run}  # fmt: skip
    empty = [k for k, n in rows.items() if n == 0]
    filters = [f for a in mapped for f in a.get("filters", [])]
    low_fill = []
    for a in mapped:
        if a["archetype"] in failing:  # skipped on approval; its fields do not matter
            continue
        expected_null = {f["field"] for f in a.get("fields", []) if not f.get("source_columns")}
        for f in by.get(a["archetype"], {}).get("fills", []):
            if f["field"] not in expected_null and (f.get("fill_pct") or 0) < 90:
                low_fill.append(f"{f['field']} {f['fill_pct']:.0f}%")
    mix: dict[str, int] = {}
    for a in mapped:
        for m in by.get(a["archetype"], {}).get("value_mix", {}).get("location_kind", []):
            mix[m["value"]] = mix.get(m["value"], 0) + m["rows"]
    total = sum(mix.values()) or 1
    other_share = 100 * mix.get("other", 0) / total
    stores = mix.get("store", 0)
    return [
        _c("tests", not failing, "Every link passes its live test",
           "All pass." if not failing else f"Failing: {', '.join(failing)} (approve skips them).",
           "Open the link in Expert view, fix the SQL and re-check."),
        _c("rows", (not empty and bool(rows)) or (not rows and bool(not_run)), "Row count in range",
           ", ".join(f"{k} {n:,}" for k, n in rows.items())
           or ("Not run in the review lab: the row counts come from their warehouse."
               if not_run else "Nothing mapped."),
           "A link returns no rows: check its filters."),
        _c("filters", bool(filters), "Fake or restored rows excluded",
           f"{len(filters)} filter(s) applied." if filters else "No filter on any link.",
           "If discovery found back-filled or test rows, add a filter."),
        _c("locations", not mix or (stores > 0 and other_share <= 10), "Location split looks usual",
           ", ".join(f"{k} {100 * v / total:.0f}%" for k, v in sorted(mix.items(), key=lambda x: -x[1]))
           or "No location kinds.", "Too many locations are 'other' or none are stores: confirm "
           "the classification with the client."),
        _c("fills", not low_fill, "Fields above 90% filled",
           "All required fields filled." if not low_fill else ", ".join(low_fill[:4]),
           "Low fill means fewer alerts on that field; tell the client or map another column."),
    ]  # fmt: skip


def checks_org(out: dict[str, Any], draft_titles: list[str]) -> list[dict[str, Any]]:
    roles = out.get("roles", [])
    tops = [r for r in roles if not r.get("parent_ref")]
    untyped = [r["title"] for r in roles if not (r.get("archetype") or r.get("role_archetype"))]
    kept = {r["title"] for r in roles}
    left = [t for t in draft_titles if t not in kept]
    notes = out.get("notes") or []
    explained = not left or any(
        str(n).strip() for n in (notes if isinstance(notes, list) else [notes])
    )
    return [
        _c("one_top", len(tops) == 1, "One top role",
           tops[0]["title"] if len(tops) == 1 else f"{len(tops)} roles without a manager.",
           "Give every role but the top one a manager."),
        _c("typed", not untyped, "Every role has a role type",
           "All typed." if not untyped else ", ".join(untyped[:4]),
           "Pick a role type so the role gets the right playbook."),
        _c("left_out", explained, "Left-out roles explained",
           f"{len(left)} left out." if left else "Nobody left out.",
           "Say why in the notes; the client sees the list."),
    ]  # fmt: skip


def checks_metrics(out: dict[str, Any], role_refs: list[str]) -> list[dict[str, Any]]:
    metrics = out.get("metrics", [])
    no_owner = [m["name"] for m in metrics if not m.get("attach")]
    covered = {a["role_ref"] for m in metrics for a in m.get("attach", [])}
    bare = [r for r in role_refs if r not in covered]
    stale = [m for m in metrics if "stale" in m.get("template", "")]
    stale_level = any(a["threshold"]["kind"] != "none" for m in stale for a in m["attach"])
    fire = [a.get("would_fire") for m in metrics for a in m.get("attach", [])]
    known = [f for f in fire if f is not None]
    return [
        _c("owners", not no_owner, "Every measure has an owner",
           "All owned." if not no_owner else ", ".join(no_owner[:3]),
           "Attach each measure to the role that acts on it."),
        _c("stale", bool(stale) and stale_level, "Stock that has not moved is watched with a level",
           "On, with an alert level." if stale and stale_level
           else "On, trend only: stock that never moves will never alert." if stale
           else "Not watched.", "Add it with a fixed alert level (Who sees what)."),
        _c("fires", not known or sum(known) > 0, "Alert levels would fire today",
           f"{sum(known)} alert(s) today across {len(known)} level(s)." if known
           else "Counts appear on new proposals.", "Every level is above today's values: lower "
           "them or the client will see nothing in the trial."),
        _c("roles", not bare, "Each role has at least one measure",
           "All roles covered." if not bare else f"{len(bare)} role(s) without a measure.",
           "Attach a measure, or accept that the role only sees roll-ups."),
    ]  # fmt: skip


def checks_rules(
    clean: dict[str, Any], effective: RulesConfig, errors: list[str]
) -> list[dict[str, Any]]:
    rules = effective.with_overrides(clean)
    floor = rules.min_signal_impact
    cards = rules.max_open_cards_per_role
    return [
        _c("floor", floor <= PRESETS["balanced"]["min_signal_impact"] * 2,
           "Money minimum lets store problems through",
           f"Problems under {floor:,.0f} are dropped.",
           "Store-level problems are often a few hundred dollars: consider Balanced or More."),
        _c("cards", 3 <= cards <= 8, "Cards per person within 3 to 8", f"{cards} per person.",
           "Fewer than 3 hides problems; more than 8 is noise."),
        _c("blocked", not errors, "No access or retention change",
           "None." if not errors else "; ".join(errors[:2]), "Remove the blocked changes."),
    ]  # fmt: skip


def checks_trial(run: dict[str, Any] | None, cards: list[dict[str, Any]], role_titles: list[str],
                 closed: list[str], rejected: int) -> list[dict[str, Any]]:  # fmt: skip
    if not run:
        return [_c("run", False, "Run succeeded", "No trial run yet.", "Start a run.")]
    got = {c["role"] for c in cards}
    without = [r for r in role_titles if r not in got]
    named_closed = [
        c["title"] for c in cards if any(x.lower() in c["title"].lower() for x in closed)
    ]
    return [
        _c("run", run["status"] in ("succeeded", "partial"), "Run succeeded",
           f"{run['status']}, {len(cards)} card(s).", "Open the run log and fix the failed step."),
        _c("rejected", rejected == 0, "No card rejected",
           "None rejected." if not rejected else f"{rejected} card(s) failed validation.",
           "Read the rejection in the run log; usually a number the writer invented."),
        _c("closed", not named_closed, "No closed location in cards",
           "None." if not named_closed else "; ".join(named_closed[:2]),
           "Mark the location as not sellable or filter it in Mapping, then run again."),
        _c("roles", not without, "Every role got a card",
           "All roles." if not without else ", ".join(without[:4]),
           "Normal for quiet roles; check their alert levels if it looks wrong."),
    ]  # fmt: skip


def decision_line(step: str, s: dict[str, Any]) -> str:
    """What approving commits the client to, in the words the client will read (English)."""
    if step == "connect":
        return "We can read their data, read-only."
    if step == "discovery":
        f = s.get("facts") or {}
        n = checked_counts(s)["limited"]
        head = (f"{f['items']:,} items, {f['locations']} locations, {f['months']} months. "
                if f.get("items") else "")  # fmt: skip
        return f"{head}Complete enough to start; {n} thing(s) limited."
    if step == "mapping":
        rows = max([d.get("rows") or 0 for d in s.get("datasets", [])] or [0])
        return (
            f"We will read {rows:,} real stock counts across {len(s.get('datasets', []))} link(s)."
        )
    if step == "org":
        return f"{len(s.get('roles', []))} people will receive cards."
    if step == "metrics":
        n = sum(len(m["for"]) for m in s.get("measures", []))
        return f"{n} alerts set on {len(s.get('measures', []))} measures."
    if step == "rules":
        floor = s.get("floor")
        return (f"They hear about problems over {floor:,.0f} {s.get('currency', '')}, "
                f"up to {s.get('cards_per_person')} cards each.").replace("  ", " ") if floor is not None \
            else "Rules unchanged."  # fmt: skip
    return f"{s.get('cards', 0)} cards for {s.get('people', 0)} people."
