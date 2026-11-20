"""Is an AI answer grounded in the context it was given? (ADR 0029)

The workspace assistant answers from a JSON context (data guide, links, org web, measures,
rules). Code checks every number in its answer against that context, the same way card text is
checked (card_validation), and reports the ones it cannot find. The answer is shown with that
report: nothing is blocked, but nothing unverified looks verified. Pure.
"""

from typing import Any

from app.domain.card_validation import number_supported, numbers_in_evidence, numbers_in_text

# Small whole numbers are usually counts the model made by reading a list ("3 roles", "step 2").
FREE_UP_TO = 12


def _numbers_in_context(value: Any) -> set[float]:
    """numbers_in_evidence, plus numbers written inside text ("404,480 rows", "3.5k")."""
    out = numbers_in_evidence(value)
    stack = [value]
    while stack:
        v = stack.pop()
        if isinstance(v, str):
            out.update(n for n, _ in numbers_in_text(v, "en"))
        elif isinstance(v, dict):
            stack.extend(v.values())
        elif isinstance(v, list | tuple):
            stack.extend(v)
    return out


def unsupported_numbers(answer: str, context: Any, language: str = "en") -> list[str]:
    """The numbers in the answer that appear nowhere in the context, as written in the answer."""
    allowed = _numbers_in_context(context)
    out: list[str] = []
    for value, precision in numbers_in_text(answer, language):
        if value <= FREE_UP_TO and value == int(value):
            continue
        if number_supported(value, allowed, precision):
            continue
        # Rounded money ("$3.07M", "$241K"): accept 3 significant digits of a context value.
        if any(abs(value - a) <= max(precision, abs(a) * 0.005) for a in allowed):
            continue
        shown = f"{value:,.0f}" if value == int(value) else f"{value:,.2f}"
        if shown not in out:
            out.append(shown)
    return out


def known_sources(sources: list[str], context: dict[str, Any]) -> list[str]:
    """Keep only the sources that name a real top-level part of the context."""
    return [s for s in sources if s.split(".")[0] in context][:8]
