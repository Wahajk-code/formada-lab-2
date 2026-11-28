"""Stability and regression: does the AI give the same answer, and the answer we approved?

Two uses of one comparison.

- Stability: ask the same AI step twice on the same input. The decisions (which column feeds which
  field, which metrics, which roles) should agree. Wording will differ and is ignored.
- Regression: ask a new prompt version on an input whose answer the team already approved. The
  approved answer is the gold answer; the share of decisions it reproduces is the score. A prompt
  change that lowers the score is worse, whatever it reads like.

Pure: no I/O. Answers are the JSON the agents return.
"""

from typing import Any

# Keys that hold wording, not a decision. Two answers are not "different" because of these.
PROSE_KEYS = frozenset(
    {
        "why", "reason", "reasons", "note", "notes", "summary", "explanation", "description",
        "rationale", "comment", "text", "purpose", "caveats", "questions", "expression", "sql",
        "source_sql", "thinking", "confidence",
    }
)  # fmt: skip
# When a list holds dicts, the first of these keys names each item, so order does not matter.
IDENTITY_KEYS = (
    "archetype",
    "field",
    "key",
    "metric_key",
    "id",
    "name",
    "title",
    "role",
    "view",
    "table",
)
MAX_SHOWN = 20


def _name(item: dict[str, Any], index: int) -> tuple[str, str | None]:
    """The item's own name and the key that holds it (None when it has none)."""
    for k in IDENTITY_KEYS:
        if k in item and isinstance(item[k], str | int):
            return str(item[k]), k
    return f"#{index}", None


def flatten(value: Any, path: str = "", ignore: frozenset[str] = PROSE_KEYS) -> dict[str, Any]:
    """Every decision in an answer as `path -> value`. Lists of plain values become sorted tuples,
    lists of objects are keyed by the object's own name."""
    out: dict[str, Any] = {}
    if isinstance(value, dict):
        for k, v in value.items():
            if k in ignore:
                continue
            out.update(flatten(v, f"{path}.{k}" if path else str(k), ignore))
    elif isinstance(value, list):
        if value and all(isinstance(i, dict) for i in value):
            seen: dict[str, int] = {}
            for i, item in enumerate(value):
                name, held_in = _name(item, i)
                seen[name] = seen.get(name, 0) + 1
                label = name if seen[name] == 1 else f"{name}~{seen[name]}"
                where = f"{path}[{label}]"
                out[where] = "present"  # the item itself is a decision: it is there or it is not
                rest = {k: v for k, v in item.items() if k != held_in}
                out.update(flatten(rest, where, ignore))
        else:
            out[path] = tuple(sorted(str(norm(i)) for i in value))
    else:
        out[path] = norm(value)
    return out


def norm(value: Any) -> Any:
    if isinstance(value, str):
        return " ".join(value.lower().split())
    if isinstance(value, float):
        return round(value, 4)
    return value


def compare(
    answers: list[dict[str, Any]], *, min_agreement_pct: float, ignore: frozenset[str] = PROSE_KEYS
) -> dict[str, Any]:
    """How much several answers to the same question agree.

    `agreement_pct` is the share of decisions on which every answer holds the same value; a
    decision one answer has and another lacks counts as a disagreement."""
    flat = [flatten(a, ignore=ignore) for a in answers]
    paths = sorted(set().union(*(f.keys() for f in flat))) if flat else []
    differing = []
    for p in paths:
        values = [f.get(p, "(missing)") for f in flat]
        if any(v != values[0] for v in values[1:]):
            differing.append({"path": p, "values": [_show(v) for v in values]})
    agree = len(paths) - len(differing)
    pct = round(agree / len(paths) * 100, 1) if paths else 100.0
    return {
        "decisions": len(paths),
        "agreeing": agree,
        "agreement_pct": pct,
        "verdict": verdict(pct, min_agreement_pct),
        "differences": differing[:MAX_SHOWN],
        "more_differences": max(len(differing) - MAX_SHOWN, 0),
    }


def regress(
    gold: dict[str, Any], answer: dict[str, Any], *, min_agreement_pct: float,
    ignore: frozenset[str] = PROSE_KEYS,
) -> dict[str, Any]:  # fmt: skip
    """The gold answer's decisions, and how many the new answer reproduces. Decisions the new answer
    adds (the gold has none there) are reported but not held against it."""
    g, a = flatten(gold, ignore=ignore), flatten(answer, ignore=ignore)
    lost = [
        {"path": p, "gold": _show(v), "answer": _show(a.get(p, "(missing)"))}
        for p, v in g.items()
        if a.get(p, "(missing)") != v
    ]
    kept = len(g) - len(lost)
    pct = round(kept / len(g) * 100, 1) if g else 100.0
    return {
        "decisions": len(g),
        "reproduced": kept,
        "agreement_pct": pct,
        "verdict": "holds" if pct >= min_agreement_pct else "regressed",
        "lost": lost[:MAX_SHOWN],
        "more_lost": max(len(lost) - MAX_SHOWN, 0),
        "added": sum(1 for p in a if p not in g),
    }


def verdict(pct: float, min_agreement_pct: float) -> str:
    if pct >= min_agreement_pct:
        return "stable"
    return "mostly" if pct >= min_agreement_pct - 20 else "unstable"


def _show(value: Any) -> Any:
    return list(value) if isinstance(value, tuple) else value
