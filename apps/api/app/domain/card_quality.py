"""How easy a card is to read and act on, scored by code (pure).

A card is read by a busy person with no analytics training. The score rewards short sentences,
everyday words, a plain headline with a number, a clear first-verb action, and no codes or
statistics words. Used to compare card writer versions on the same signals.
"""

import re
from typing import Any

SENTENCE = re.compile(r"(?<=[.!?])\s+")
WORD = re.compile(r"[A-Za-z][A-Za-z'-]*")
JARGON = re.compile(
    r"\b(z[- ]?score|standard deviation|percentile|baseline|mean|median|threshold|signal|"
    r"excess|multiple|variance|points? of share|kpi|sku-level|granular)\b",
    re.IGNORECASE,
)
LEADING_CODE = re.compile(r"(^|\s)\d{3,}\s*-\s")
ACTION_VERBS = frozenset(
    [
        "call",
        "check",
        "ask",
        "review",
        "move",
        "pause",
        "reorder",
        "renegotiate",
        "request",
        "propose",
        "confirm",
        "compare",
        "contact",
        "talk",
        "plan",
        "set",
        "cut",
        "raise",
        "lower",
        "stop",
        "start",
        "fix",
        "find",
        "decide",
        "send",
        "schedule",
        "agree",
        "reduce",
        "increase",
        "shift",
        "push",
        "hold",
        "clear",
        "order",
        "negotiate",
        "investigate",
    ]
)
CONSULTANCY = re.compile(
    r"(leverage|synerg\w*|holistic|stakeholders?|paradigm|going forward|commission|ascertain|"
    r"facilitate|optimi[sz]e|mitigate|utili[sz]e)",
    re.IGNORECASE,
)
BARE_DECIMAL = re.compile(r"\d+\.\d+(?=\s*[,.;]|\s*$)")


def _syllables(word: str) -> int:
    groups = re.findall(r"[aeiouy]+", word.lower())
    n = len(groups)
    if word.lower().endswith("e") and n > 1:
        n -= 1
    return max(1, n)


def grade_level(text: str) -> float:
    """Flesch-Kincaid grade (US school grade needed to follow the text)."""
    sentences = [s for s in SENTENCE.split(text.strip()) if s]
    words = WORD.findall(text)
    if not sentences or not words:
        return 0.0
    syllables = sum(_syllables(w) for w in words)
    return 0.39 * len(words) / len(sentences) + 11.8 * syllables / len(words) - 15.59


def score_card(card: dict[str, Any]) -> dict[str, Any]:
    body = " ".join(str(card.get(k, "")) for k in ("what", "so_what", "now_what"))
    title = str(card.get("title", ""))
    full = f"{title}. {body}"
    problems: list[str] = []
    score = 100.0

    grade = grade_level(body)
    if grade > 9:
        score -= min(25, (grade - 9) * 5)
        problems.append(f"reads at grade {grade:.0f} (aim for 9 or lower)")
    longest = max((len(WORD.findall(s)) for s in SENTENCE.split(body) if s), default=0)
    if longest > 28:
        score -= 10
        problems.append(f"one sentence has {longest} words")
    found = {m.group(0).lower() for m in JARGON.finditer(full)}
    if found:
        score -= min(40, 8 * len(found))
        problems.append("analyst words: " + ", ".join(sorted(found)))
    if LEADING_CODE.search(full):
        score -= 10
        problems.append("shows a store or supplier code")
    if CONSULTANCY.search(full):
        score -= 5
        problems.append("consultant wording")
    if BARE_DECIMAL.search(body):
        score -= 6
        problems.append("a number has no unit (%, CAD, days)")
    if not re.search(r"\d", title):
        score -= 8
        problems.append("headline has no number")
    if len(title) > 80:
        score -= 5
        problems.append("headline is long")
    first = (WORD.findall(str(card.get("now_what", ""))) or [""])[0].lower()
    if first not in ACTION_VERBS:
        score -= 10
        problems.append(f"action starts with {first!r}, not a plain verb")
    if len(WORD.findall(body)) > 110:
        score -= 8
        problems.append("longer than a ten-second read")
    return {"score": max(0, round(score)), "grade": round(grade, 1), "problems": problems}


def score_cards(cards: list[dict[str, Any]]) -> dict[str, Any]:
    scored = [score_card(c) for c in cards]
    avg = round(sum(s["score"] for s in scored) / len(scored)) if scored else 0
    return {"average": avg, "cards": scored}
