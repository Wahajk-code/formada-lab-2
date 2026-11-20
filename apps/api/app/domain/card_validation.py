"""Validate LLM-proposed cards before storage (spec: Pipeline step 6).

A card is rejected when:
  - a number in its text does not appear in its signal's evidence (or the role profile),
  - its action is not one of the role's owned decisions, or matches a forbidden decision or an
    active forbid rule,
  - an open card with the same fingerprint already exists for the role,
  - it references a signal that was not given to the LLM.
"""

import re
import unicodedata
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Any

MAX_TITLE = 80

# 48,000 | 48 000 | 48000 | 27.5 | 27,5 | 4.2k | -3
_NUMBER_EN = re.compile(r"(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?")
_FR_GROUP = " \u00a0\u202f"  # French thousands separators: space, no-break, narrow
# French text also accepts a dot decimal: models copy evidence values ("39102.61") verbatim, and
# Canadian French never groups thousands with dots (iteration 4).
_NUMBER_FR = re.compile(
    rf"(?<![\w,.])-?\d{{1,3}}(?:[{_FR_GROUP}]\d{{3}})+(?:[,.]\d+)?|-?\d+(?:[,.]\d+)?"
)
_SUFFIX = re.compile(r"^\s?([kKmM])\b")
_STOPWORDS = {
    "a", "an", "the", "to", "of", "for", "on", "in", "with", "and", "or", "new", "any",
    "le", "la", "les", "un", "une", "des", "de", "du", "au", "aux", "et", "ou", "pour", "sur",
}  # fmt: skip


@dataclass(frozen=True)
class CardCandidate:
    signal_id: str
    title: str
    what: str
    so_what: str
    now_what: str
    decision_used: str


@dataclass(frozen=True)
class ValidationContext:
    language: str
    evidence_by_signal: dict[str, dict[str, Any]]
    fingerprint_by_signal: dict[str, str]
    decisions_owned: list[str]
    decisions_forbidden: list[str]
    forbid_rules: list[str]
    open_fingerprints: frozenset[str]
    profile_text: str


def _fold(text: str) -> str:
    stripped = unicodedata.normalize("NFKD", text.casefold())
    return "".join(c for c in stripped if not unicodedata.combining(c))


def numbers_in_text(text: str, language: str) -> list[tuple[float, float]]:
    """(value, precision) per number; "48k" is (48000, 1000) since it was rounded to thousands."""
    pattern = _NUMBER_FR if language == "fr" else _NUMBER_EN
    found = []
    for m in pattern.finditer(text):
        raw = m.group(0)
        if language == "fr":
            raw = re.sub(f"[{_FR_GROUP}]", "", raw).replace(",", ".")
        else:
            raw = raw.replace(",", "")
        value, precision = float(raw), 1.0
        suffix = _SUFFIX.match(text[m.end() :])
        if suffix:
            precision = 1_000 if suffix.group(1) in "kK" else 1_000_000
            value *= precision
        found.append((abs(value), precision))
    return found


def numbers_in_evidence(value: Any) -> set[float]:
    """Every numeric value in the evidence, including digits inside strings (dates, codes)."""
    out: set[float] = set()
    if isinstance(value, bool):
        return out
    if isinstance(value, int | float):
        out.add(abs(float(value)))
    elif isinstance(value, str):
        out.update(abs(float(n)) for n in re.findall(r"\d+(?:\.\d+)?", value))
    elif isinstance(value, dict):
        # Keys too: the model reads them ("units_13w" -> "13 weeks"), iteration 5.
        for k, v in value.items():
            out |= numbers_in_evidence(str(k)) | numbers_in_evidence(v)
    elif isinstance(value, list | tuple):
        for v in value:
            out |= numbers_in_evidence(v)
    return out


def number_supported(n: float, allowed: Iterable[float], precision: float = 1.0) -> bool:
    """n matches an allowed value as written, or rounded/truncated to its precision (rule 1)."""
    for a in allowed:
        if precision > 1:
            if n in (round(a / precision) * precision, int(a / precision) * precision):
                return True
            continue
        if abs(n - a) < 1e-6 or abs(n - round(a)) < 1e-6 or n == int(a):
            return True
        if n != int(n) and any(abs(n - round(a, d)) < 1e-6 for d in (1, 2)):
            return True
    return False


def _content_words(text: str) -> set[str]:
    return {w for w in re.findall(r"[a-z]+", _fold(text)) if w not in _STOPWORDS and len(w) > 2}


def violates(action: str, forbidden: str) -> bool:
    """All content words of the forbidden decision appear in the action text."""
    words = _content_words(forbidden)
    return bool(words) and words <= _content_words(action)


_BARE = re.compile(r"(?<![\w.,/#-])(\$?)(\d{4,})(\.\d+)?(?![\w-])")
_AMOUNT_AFTER = re.compile(
    r"^\s?(?:\$|CAD\b|USD\b|EUR\b|k\b|units?\b|unit\u00e9s?\b|g\b|kg\b|ea\b|lines?\b|lignes?\b|%)",
    re.IGNORECASE,
)


def group_numbers(text: str, language: str) -> str:
    """Thousands separators on amounts the writer copied bare from the evidence ("3065242.89 CAD"
    -> "3,065,242.89 CAD"; French "3 065 242,89 CAD"). Only numbers that read as amounts or
    quantities (a decimal part, a $ sign, or a currency or unit after them), so years, dates and
    item codes stay as they are. Values do not change, so validation is unaffected."""

    def fix(m: re.Match[str]) -> str:
        dollar, whole, dec = m.group(1), m.group(2), m.group(3) or ""
        if not (dec or dollar or _AMOUNT_AFTER.match(text[m.end() :])):
            return m.group(0)
        if language == "fr":
            grouped = f"{int(whole):,}".replace(",", "\u202f")
            return f"{dollar}{grouped}{dec.replace('.', ',')}"
        return f"{dollar}{int(whole):,}{dec}"

    return _BARE.sub(fix, text)


def fit_title(title: str) -> str:
    """Shorten an over-long title at a word boundary instead of rejecting the card (iteration 4:
    a valid Boutique Laurier card was lost over 82 characters; French titles run long)."""
    title = title.strip()
    if len(title) <= MAX_TITLE:
        return title
    cut = title[: MAX_TITLE - 1]
    if " " in cut:
        cut = cut[: cut.rindex(" ")]
    return cut.rstrip(" ,;:-") + "…"


# Statistics words a manager should never meet on a card.
JARGON = re.compile(
    r"(z[- ]?score|standard deviation|percentile|baseline mean|excess_over_threshold|signal_kind)",
    re.IGNORECASE,
)


def validate(card: CardCandidate, ctx: ValidationContext) -> list[str]:
    reasons: list[str] = []
    evidence = ctx.evidence_by_signal.get(card.signal_id)
    if evidence is None:
        return [f"unknown signal_id {card.signal_id}"]

    allowed = numbers_in_evidence(evidence) | numbers_in_evidence(ctx.profile_text)
    for field in ("title", "what", "so_what", "now_what"):
        for n, precision in numbers_in_text(getattr(card, field), ctx.language):
            if not number_supported(n, allowed, precision):
                reasons.append(f"{field}: number {n:g} not in evidence")

    for field in ("title", "what", "so_what", "now_what"):
        if found := JARGON.search(getattr(card, field)):
            reasons.append(
                f"{field}: uses analyst wording ({found.group(0)!r}); say it in plain words"
            )

    owned = {_fold(d).strip() for d in ctx.decisions_owned}
    if _fold(card.decision_used).strip() not in owned:
        reasons.append(f"decision_used {card.decision_used!r} is not a decision this role owns")
    for forbidden in [*ctx.decisions_forbidden, *ctx.forbid_rules]:
        if violates(card.now_what, forbidden) or violates(card.decision_used, forbidden):
            reasons.append(f"now_what conflicts with forbidden decision {forbidden!r}")

    fingerprint = ctx.fingerprint_by_signal.get(card.signal_id)
    if fingerprint in ctx.open_fingerprints:
        reasons.append("an open card with the same fingerprint exists")
    return reasons
