"""AI agent rules (ADR 0022). Pure: example selection, number checks, version stats.

The learning loop does not train a model. It changes what an agent reads: past cards the team
acted on (positive examples) and cards it rejected with a reason (counter-examples). Numbers are
masked in examples, so the writer copies the tone and the kind of action, never a figure (the
validator would reject a card quoting a number from another signal).
"""

import re
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime

from app.domain.feedback import NOT_RELEVANT_REASONS, counts_towards_downweight, parse_reason

AGENT_KINDS = ("card_writer", "translator", "rule_drafter", "onboarding")

_NUMBER = re.compile(r"\d[\d\s.,]*\d|\d")


@dataclass(frozen=True)
class PastCard:
    title: str
    now_what: str
    status: str  # actioned | not_relevant | impossible
    reason: str | None
    metric_key: str
    at: datetime


def mask_numbers(text: str) -> str:
    return _NUMBER.sub("N", text)


def select_examples(
    cards: Iterable[PastCard], metric_keys: set[str], since: datetime, limit: int
) -> tuple[list[PastCard], list[PastCard]]:
    """(positive, negative), newest first, same metrics as this run's signals preferred."""
    recent = [c for c in cards if c.at >= since]
    recent.sort(key=lambda c: (c.metric_key in metric_keys, c.at), reverse=True)
    half = max(1, limit // 2) if limit else 0
    positive = [c for c in recent if c.status == "actioned"][:half]
    # A card rejected because the number looked wrong, or because it was already handled or not
    # wanted now, says nothing about whether this kind of card is useful: it is not a lesson.
    negative = [
        c
        for c in recent
        if c.status == "impossible"
        or (c.status == "not_relevant" and counts_towards_downweight(c.reason))
    ][: limit - len(positive)]
    return positive, negative


def examples_block(positive: list[PastCard], negative: list[PastCard]) -> str:
    """Appended to the user prompt. Empty when there is nothing to learn from yet."""
    if not positive and not negative:
        return ""
    lines = ["", "Feedback from this team (numbers masked as N; never copy them):"]
    if positive:
        lines.append("Cards they acted on (good examples of a useful action):")
        lines += [f"- {mask_numbers(c.title)} -> {mask_numbers(c.now_what)}" for c in positive]
    if negative:
        lines.append("Cards they rejected (avoid suggesting the same kind of thing):")
        for c in negative:
            code, words = parse_reason(c.reason)
            said = ": ".join(x for x in (NOT_RELEVANT_REASONS.get(code or ""), words) if x)
            why = f" (reason: {mask_numbers(said)})" if said else ""
            lines.append(f"- [{c.status}] {mask_numbers(c.title)}{why}")
    return "\n".join(lines)


def numbers_of(text: str) -> list[str]:
    """Digit runs in order, separators removed: '48 000,5' and '48,000.5' both give ['480005']."""
    return [re.sub(r"\D", "", m) for m in _NUMBER.findall(text)]


def translation_keeps_numbers(original: str, translated: str) -> bool:
    """A translation must carry exactly the same digits (in any order); formatting may change."""
    return sorted(numbers_of(original)) == sorted(numbers_of(translated))


@dataclass(frozen=True)
class VersionStats:
    cards: int
    actioned: int
    not_relevant: int
    impossible: int
    expired: int
    open: int
    rejected: int

    @property
    def decided(self) -> int:
        return self.actioned + self.not_relevant + self.impossible

    @property
    def action_rate(self) -> float | None:
        return self.actioned / self.decided if self.decided else None

    @property
    def not_relevant_rate(self) -> float | None:
        return self.not_relevant / self.decided if self.decided else None

    @property
    def rejection_rate(self) -> float | None:
        written = self.cards + self.rejected
        return self.rejected / written if written else None


def version_stats(statuses: Iterable[str], rejected: int) -> VersionStats:
    counts = {"actioned": 0, "not_relevant": 0, "impossible": 0, "expired": 0, "open": 0}
    total = 0
    for s in statuses:
        total += 1
        if s in counts:
            counts[s] += 1
    return VersionStats(cards=total, rejected=rejected, **counts)
