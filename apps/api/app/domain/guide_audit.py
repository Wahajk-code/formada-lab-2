"""Audit a data guide against the facts the profile measured (the guide's ground truth).

Pure. Used by the AI lab to score prompt variants and by the rounds that tune discovery: a guide
is good when code can prove its claims, it names every table and view, its verdicts match what was
measured, and a non-technical reader can follow it.
"""

import re
from typing import Any

from app.domain import onboarding as ob

SENTENCE = re.compile(r"[.!?]+(?:\s+|$)")
JARGON = re.compile(
    r"\b(z[- ]?score|standard deviation|percentile|cardinality|grain|denormali[sz]ed|"
    r"surrogate|idempotent|orphan values?)\b",
    re.IGNORECASE,
)
FAMILY_HINTS = {
    "sales": re.compile(r"SALES|CASHSALE|INVOICE", re.IGNORECASE),
    "purchase_orders": re.compile(r"PURCHASE", re.IGNORECASE),
    "inventory": re.compile(r"INVENTORY", re.IGNORECASE),
    "transfers": re.compile(r"TRANSFER", re.IGNORECASE),
}


def _item(name: str, points: float, max_points: float, note: str) -> dict[str, Any]:
    return {"name": name, "points": round(points, 1), "max": max_points, "note": note}


def _fraction(hit: float, total: int) -> float:
    return hit / total if total else 1.0


def _text(out: dict[str, Any]) -> str:
    bits = [out.get("summary", ""), out.get("cadence", "")]
    bits += [
        q.get("title", "") + " " + q.get("evidence", "") for q in out.get("quality_issues", [])
    ]
    bits += [c.get("evidence", "") for c in out.get("coverage", [])]
    for g in out.get("semantic_views", []):
        bits += [g.get("purpose", ""), g.get("grain", ""), *g.get("caveats", [])]
    return " ".join(bits)


def _measured_families(profile: dict[str, Any]) -> dict[str, list[str]]:
    """Family -> fact tables of the semantic views that were measured and hold dates."""
    found: dict[str, list[str]] = {}
    for v in profile.get("semantic_views", []):
        for t in v.get("tables", []):
            m = t.get("measured")
            if not m or not (m.get("dates") or m.get("first_date")):
                continue
            for family, hint in FAMILY_HINTS.items():
                if hint.search(t["table"]):
                    found.setdefault(family, []).append(t["table"])
    return found


def _words_per_sentence(text: str) -> float:
    sentences = [s for s in SENTENCE.split(text) if s.strip()]
    words = len(text.split())
    return words / max(1, len(sentences))


def audit(out: dict[str, Any], profile: dict[str, Any]) -> dict[str, Any]:
    items: list[dict[str, Any]] = []
    report = ob.check_discovery(out, profile)
    items.append(
        _item("Every claim is true", max(0.0, 20 - 4 * len(report.errors)), 20,
              f"{len(report.errors)} check errors")
    )  # fmt: skip

    profiled = {t["table"].upper() for t in profile.get("tables", [])}
    described = {t["table"].upper() for t in out.get("tables", [])} & profiled
    items.append(_item("Every table described", 10 * _fraction(len(described), len(profiled)), 10,
                       f"{len(described)} of {len(profiled)} tables"))  # fmt: skip

    views = [str(v["view"]).upper() for v in profile.get("semantic_views", [])]
    guided = {str(g["view"]).upper() for g in out.get("semantic_views", [])}
    n_guided = len(guided & set(views))
    items.append(
        _item("Every semantic view described", 10 * _fraction(n_guided, len(views)), 10,
              f"{n_guided} of {len(views)} views")
    )  # fmt: skip

    text = _text(out).upper()
    facts = [t["table"] for v in profile.get("semantic_views", []) for t in v.get("tables", [])
             if t.get("metrics")]  # fmt: skip
    named = sum(
        1 for f in facts if f in text
        or any(f"{f}." in str(m).upper() for g in out.get("semantic_views", [])
               for m in g.get("key_metrics", []))
    )  # fmt: skip
    items.append(_item("Every fact table in the views named", 10 * _fraction(named, len(facts)),
                       10, f"{named} of {len(facts)} fact tables"))  # fmt: skip

    false_links = sum(1 for w in report.warnings if "not supported" in w or "not tested" in w)
    items.append(_item("No invented joins", max(0.0, 10 - 5 * false_links), 10,
                       f"{false_links} joins the data did not support"))  # fmt: skip

    families = _measured_families(profile)
    status = {c["family"]: c["status"] for c in out.get("coverage", [])}
    right = sum(
        1.0 if status.get(f) == "present" else 0.5 if status.get(f) == "partial" else 0.0
        for f in families
    )
    items.append(
        _item("Coverage matches what was measured", 15 * _fraction(right, len(families)), 15,
              f"{right:g} of {len(families)} measured families rated present")
    )  # fmt: skip

    readable = {"inventory": r"INVENTORY|ITEMLOCATION", "calendar": r"CALENDAR"}
    supported = set(families) | {
        f for f, pat in readable.items() if any(re.search(pat, t) for t in profiled)
    }
    unproven = sorted(f for f, st in status.items() if st == "present" and f not in supported)
    items.append(
        _item("No 'present' without proof", max(0.0, 6 - 2 * len(unproven)), 6,
              "unproven: " + (", ".join(unproven) or "none"))
    )  # fmt: skip

    ref_only = [
        g for g in out.get("semantic_views", [])
        if g["use_for"] == "reference_only" and any(f in families for f in g.get("families", []))
    ]  # fmt: skip
    items.append(_item("View-or-tables decision is sensible", 10 if not ref_only else 4, 10,
                       f"{len(ref_only)} measured views marked reference only"))  # fmt: skip

    issues = out.get("quality_issues", [])
    solid = [
        q
        for q in issues
        if re.search(r"\d", q.get("evidence", ""))
        and q.get("suggested_handling")
        and q.get("impact")
    ]
    items.append(
        _item("Each issue has numbers, impact and a fix", 10 * _fraction(len(solid), len(issues)),
              10, f"{len(solid)} of {len(issues)} issues")
    )  # fmt: skip

    recall = _known_issue_recall(out, profile)
    items.append(_item("Known data problems are mentioned", 5 * recall[0], 5, recall[1]))

    summary = out.get("summary", "")
    wps = _words_per_sentence(summary)
    jargon = len(JARGON.findall(_text(out)))
    plain = 10 - (3 if wps > 24 else 0) - min(5, jargon)
    items.append(_item("Plain language", max(0, plain), 10,
                       f"{wps:.0f} words per sentence, {jargon} jargon words"))  # fmt: skip

    qs = out.get("questions", [])
    qok = len(qs) <= 6 and all(q.get("why") for q in qs)
    items.append(_item("Few, justified questions", 5 if qok else 2, 5, f"{len(qs)} questions"))

    total = sum(i["points"] for i in items)
    maximum = sum(i["max"] for i in items)
    return {"score": round(100 * total / maximum), "items": items}


def _known_issue_recall(out: dict[str, Any], profile: dict[str, Any]) -> tuple[float, str]:
    """Problems the profile proves (carried rows, a break, a cadence change): are they named?"""
    text = _text(out).lower()
    expected: list[tuple[str, bool]] = []
    tp = profile.get("time_profile") or {}
    for b in (tp.get("row_breaks") or [])[:1]:
        expected.append(("a row-count break", str(b.get("date", "")) in text))
    cad = tp.get("cadence") or {}
    if len(cad.get("runs", [])) > 1:
        expected.append(("a cadence change", "daily" in text or "weekly" in text))
    for c in profile.get("categories", []):
        if any(re.search(r"(backfill|carry|_cf$)", str(v["value"]), re.I) for v in c["values"]):
            expected.append(("carried-forward rows", "carried" in text or "back-fill" in text
                             or "backfill" in text))  # fmt: skip
            break
    hit = sum(1 for _n, ok in expected if ok)
    return _fraction(hit, len(expected)), f"{hit} of {len(expected)} proven problems mentioned"
