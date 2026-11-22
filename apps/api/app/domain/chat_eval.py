"""Scoring the workspace chat (pure rules, no I/O, no AI).

The chat is general: it must behave the same way for any customer. So every check reads only the
answer and the context that was given for that workspace, never a customer's name or number. A
prompt version is better when it passes more checks on the same questions, and is never worse on
one it used to pass (see `compare`).

Words used here: a *case* is one question with what is attached to it; a *check* is one yes/no
rule about the answer; a *result* is the answer's checks.
"""

import json
import re
from typing import Any

MAX_WORDS = 170  # a short answer: a few sentences or a short list

# An apostrophe, straight or curly (the model uses both).
APOS = "['\N{RIGHT SINGLE QUOTATION MARK}]"

# An answer that cannot tell what the person means. Wrong when something was attached with @.
CONFUSED = re.compile(
    rf"\b(too vague|is vague|unclear what|not clear what|can{APOS}?t tell what|cannot tell what|"
    r"which (?:item|one|card|field|mapping) (?:do you|you)|what (?:do you|you) mean|"
    rf"conversation is empty|nothing (?:was )?named|did not name|didn{APOS}?t name|"
    r"please say which|please specify|could you (?:clarify|specify))\b",
    re.I,
)
# The answer says the context does not hold the thing asked.
ADMITS_MISSING = re.compile(
    r"\b(not in (?:the|this) (?:context|guide|data|workspace)|"
    r"no (?:data|figure|number|information) (?:on|about|for|in)|"
    rf"does not (?:hold|contain|include|say|show)|do not have|don{APOS}?t have|"
    r"cannot (?:find|see|tell)|not (?:available|measured|stated|given|provided)|"
    r"(?:was|were|are|is) not (?:measured|read|provided))\b",
    re.I,
)
SUGGESTION = re.compile(r"\bmy suggestion\b", re.I)
# A technical name: UPPER_SNAKE or lower_snake with at least one underscore, or SCHEMA.TABLE.
IDENTIFIER = re.compile(
    r"\b(?:[A-Z][A-Z0-9]*_[A-Z0-9_]+|[a-z][a-z0-9]*_[a-z0-9_]+|[A-Z0-9_]+\.[A-Z0-9_]+)\b"
)
STOP = {
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "per",
    "one",
    "all",
    "not",
    "are",
    "was",
}


def words(text: str) -> int:
    return len(re.findall(r"\S+", text))


def _tokens(label: str) -> set[str]:
    """The distinctive parts of an item's name: `net_amount` -> {net, amount, net_amount}."""
    flat = re.sub(r"[^a-z0-9_ ]+", " ", label.lower())
    parts = {t for t in re.split(r"[_ ]+", flat) if len(t) > 2 and t not in STOP}
    return parts | {t for t in flat.split() if "_" in t}


def mentions_attached(answer: str, labels: list[str]) -> bool:
    """The answer is about what was attached: it uses a distinctive part of at least one name."""
    low = answer.lower()
    spaced = low.replace("_", " ")
    return any(
        tok in low or tok.replace("_", " ") in spaced for lab in labels for tok in _tokens(lab)
    )


def identifiers(text: str) -> set[str]:
    return {m.upper() for m in IDENTIFIER.findall(text)}


def names_known(answer: str, ctx: Any) -> list[str]:
    """Technical names in the answer that are not in the context (invented tables or fields)."""
    haystack = json.dumps(ctx, default=str).upper()
    return sorted(
        n for n in identifiers(answer) if n not in haystack and n.split(".")[-1] not in haystack
    )


# check key -> (what it asks, the rule); the rule gets the case, the answer and what code measured
CHECKS: dict[str, str] = {
    "numbers_verified": "Every number in the answer is in the context",
    "names_known": "Every table or field named is in the context",
    "concise": f"At most {MAX_WORDS} words",
    "not_confused": "Does not say it cannot tell what 'it' or 'this' means",
    "mentions_attached": "Answers about what was attached",
    "marks_own_suggestion": "Calls its own idea 'my suggestion'",
    "admits_missing": "Says so when the context does not hold the answer",
    "plain_words": "No technical names when asked to keep it simple",
    "useful_when_vague": "A vague question still gets something to work with",
    "grounded_flag": "Says grounded (yes or partly), not 'no', when the context holds the answer",
}


def evaluate(
    case: dict[str, Any], answer: str, measured: dict[str, Any], ctx: Any
) -> dict[str, bool]:
    """The checks this case asks for, each true when the answer passes. `measured` has what code
    found about the answer: `unverified` numbers, `grounded`, and the labels attached."""
    wanted: list[str] = case.get("checks", [])
    labels: list[str] = measured.get("attached_labels", [])
    result: dict[str, bool] = {}
    for key in wanted:
        if key == "numbers_verified":
            result[key] = not measured.get("unverified")
        elif key == "names_known":
            result[key] = not names_known(answer, ctx)
        elif key == "concise":
            result[key] = words(answer) <= int(case.get("max_words", MAX_WORDS))
        elif key == "not_confused":
            result[key] = not CONFUSED.search(answer)
        elif key == "mentions_attached":
            result[key] = bool(labels) and mentions_attached(answer, labels)
        elif key == "marks_own_suggestion":
            result[key] = bool(SUGGESTION.search(answer))
        elif key == "admits_missing":
            result[key] = bool(ADMITS_MISSING.search(answer)) or measured.get("grounded") == "no"
        elif key == "plain_words":
            result[key] = not identifiers(answer)
        elif key == "useful_when_vague":
            result[key] = words(answer) >= 25 and not answer.strip().endswith("?")
        elif key == "grounded_flag":
            result[key] = measured.get("grounded") in ("yes", "partly")
        else:
            raise ValueError(f"unknown check {key}")
    return result


def summarize(results: dict[str, dict[str, dict[str, bool]]]) -> dict[str, Any]:
    """`results[version][case_id]` = checks. Totals per version and the checks that differ."""
    versions = list(results)
    totals = {
        v: {
            "passed": sum(sum(c.values()) for c in results[v].values()),
            "checks": sum(len(c) for c in results[v].values()),
        }
        for v in versions
    }
    case_ids = sorted({cid for v in versions for cid in results[v]})
    differences: list[dict[str, Any]] = []
    for cid in case_ids:
        keys = sorted({k for v in versions for k in results[v].get(cid, {})})
        for k in keys:
            row = {v: results[v].get(cid, {}).get(k) for v in versions}
            if len({x for x in row.values() if x is not None}) > 1:
                differences.append({"case": cid, "check": k, **row})
    return {"totals": totals, "differences": differences}


def regressions(summary: dict[str, Any], old: str, new: str) -> list[dict[str, Any]]:
    """Checks the old version passed that the new one fails: a reason not to promote it."""
    return [d for d in summary["differences"] if d.get(old) is True and d.get(new) is False]


def verdict(summary: dict[str, Any], old: str, new: str) -> str:
    """Promote only if it passes at least as many checks overall and loses none it had."""
    t = summary["totals"]
    lost = regressions(summary, old, new)
    if lost:
        return f"do not promote: {len(lost)} check(s) got worse"
    if t[new]["passed"] < t[old]["passed"]:
        return "do not promote: passes fewer checks"
    if t[new]["passed"] == t[old]["passed"]:
        return "no difference: keep the current version"
    return "promote: passes more checks and loses none"


def question_with_mentions(text: str, labels: list[str]) -> str:
    """The question as the chat receives it: the person's words, then what they attached.
    Mirrors `questionWithMentions` in apps/web/src/lib/mentions.ts."""
    if not labels:
        return text
    named = "; ".join(labels)
    return f'{text}\n\n(Attached with @, this is what "it", "this" and "these" mean: {named})'
