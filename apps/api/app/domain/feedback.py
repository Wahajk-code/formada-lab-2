"""Feedback loop rules on plain objects (spec: Feedback loop and outcome measurement).

  Not relevant: the card closes and its fingerprint is suppressed for the role for 8 weeks
                (filtering). After N on the same metric for one role, a downweight is proposed.
  Impossible:   the card closes and the fingerprint is never suggested again to the role. On the
                first one, a forbid rule is proposed with the reason as its text.

Proposals only: nothing changes the agent until a reviewer accepts the rule.
"""

import uuid
from collections import defaultdict
from collections.abc import Iterable
from dataclasses import dataclass, field

from app.domain.config import RulesConfig

FEEDBACK_TYPES = ("not_relevant", "impossible")

# Why an owner calls a card Not relevant. The reason is stored in the feedback's reason text as
# "[code] words", so no schema change is needed. Each code means something different to the loop:
#   already_handled, not_now  the card is fine, just not wanted now. It closes and teaches nothing.
#   too_small, not_my_call, other
#                             not worth this role's time: counts towards a downweight.
#   wrong_number              the number looks wrong: a DATA problem, not a relevance one. It never
#                             counts towards a downweight; the data team sees it in the console.
NOT_RELEVANT_REASONS: dict[str, str] = {
    "already_handled": "Already handled or known",
    "too_small": "Too small to matter",
    "not_my_call": "Not my decision",
    "not_now": "Not the right time",
    "wrong_number": "The number looks wrong",
    "other": "Something else",
}
RELEVANCE_REASONS = frozenset({"too_small", "not_my_call", "other"})
WRONG_NUMBER = "wrong_number"


def encode_reason(code: str | None, text: str | None) -> str | None:
    """The reason as stored: "[code] words", just the words, or None."""
    words = (text or "").strip()
    if code:
        return f"[{code}] {words}".strip()
    return words or None


def parse_reason(reason: str | None) -> tuple[str | None, str]:
    """(code, words) of a stored reason. A reason with no known code is all words."""
    text = (reason or "").strip()
    if text.startswith("[") and "]" in text:
        code, _, rest = text[1:].partition("]")
        if code in NOT_RELEVANT_REASONS:
            return code, rest.strip()
    return None, text


def counts_towards_downweight(reason: str | None) -> bool:
    """Whether a Not relevant answer says the measure is not worth the role's time."""
    code, _ = parse_reason(reason)
    return code is None or code in RELEVANCE_REASONS


def feedback_effect(type_: str, code: str | None, suppress_days: int, downweight_after: int) -> str:
    """What the owner is told their answer does, in plain words (the loop made visible)."""
    weeks = max(1, round(suppress_days / 7))
    if type_ == "impossible":
        return (
            "Closed. We will not suggest this exact action to your role again. Our team reads your "
            "reason and may turn it into a rule."
        )
    if code == WRONG_NUMBER:
        return (
            "Thanks, closed. We flagged the number to our data team, who will check the source. "
            "This does not count against the measure; the card can return once the data is right."
        )
    if code in ("already_handled", "not_now"):
        return f"Closed. We will not show this card to you again for {weeks} weeks."
    return (
        f"Closed. We will not show this card to you again for {weeks} weeks. After "
        f"{downweight_after} like this on the same measure, we propose showing it less often to "
        "your role, and our team reviews that first."
    )


@dataclass(frozen=True)
class FeedbackItem:
    id: uuid.UUID
    role_node_id: uuid.UUID
    type: str
    reason: str | None
    metric_id: uuid.UUID | None
    metric_name: str
    fingerprint: str


@dataclass(frozen=True)
class ExistingRule:
    role_node_id: uuid.UUID
    rule_type: str
    metric_id: uuid.UUID | None
    fingerprint: str | None
    status: str
    source_feedback_ids: frozenset[uuid.UUID] = field(default_factory=frozenset)


@dataclass(frozen=True)
class RuleProposal:
    role_node_id: uuid.UUID
    rule_type: str  # downweight | forbid
    metric_id: uuid.UUID | None
    fingerprint: str | None
    text: str
    source_feedback_ids: list[uuid.UUID]


def check_feedback(type_: str, reason: str | None, code: str | None = None) -> str | None:
    """Error message, or None if the feedback is valid (reason required for Impossible; a reason
    code only for Not relevant, and one we know)."""
    if type_ not in FEEDBACK_TYPES:
        return f"unknown feedback type {type_!r}"
    if type_ == "impossible" and not (reason or "").strip():
        return "a reason is required for Impossible"
    if code is not None and (type_ != "not_relevant" or code not in NOT_RELEVANT_REASONS):
        return f"unknown reason {code!r}"
    return None


def propose_rules(
    feedback: Iterable[FeedbackItem], existing: Iterable[ExistingRule], rules: RulesConfig
) -> list[RuleProposal]:
    existing = list(existing)
    live = [r for r in existing if r.status in ("proposed", "active")]
    used = {fid for r in existing for fid in r.source_feedback_ids}
    proposals: list[RuleProposal] = []

    not_relevant: dict[tuple[uuid.UUID, uuid.UUID], list[FeedbackItem]] = defaultdict(list)
    for f in feedback:
        if f.id in used:
            continue
        if f.type == "impossible":
            if any(
                r.rule_type == "forbid"
                and r.role_node_id == f.role_node_id
                and r.fingerprint == f.fingerprint
                for r in live
            ):
                continue
            proposals.append(
                RuleProposal(
                    f.role_node_id, "forbid", f.metric_id, f.fingerprint,
                    (f.reason or "").strip(), [f.id],
                )
            )  # fmt: skip
        elif (
            f.type == "not_relevant"
            and f.metric_id is not None
            and counts_towards_downweight(f.reason)  # a wrong number is a data problem, not this
        ):
            not_relevant[(f.role_node_id, f.metric_id)].append(f)

    for (role_id, metric_id), items in not_relevant.items():
        if len(items) < rules.not_relevant_for_downweight:
            continue
        if any(
            r.rule_type == "downweight" and r.role_node_id == role_id and r.metric_id == metric_id
            for r in live
        ):
            continue
        proposals.append(
            RuleProposal(
                role_id,
                "downweight",
                metric_id,
                None,
                f"Downweight {items[0].metric_name}: marked Not relevant {len(items)} times",
                [f.id for f in items],
            )
        )
    return proposals


# ---------------------------------------------------------------------------------------------
# The trial run: our team rates a card before go-live (a review aid that can propose a rule)
# ---------------------------------------------------------------------------------------------

TRIAL_RATINGS = ("useful", "not_relevant", "impossible", "wrong_number")


def check_trial_rating(rating: str, note: str | None) -> str | None:
    """Error message, or None. Saying why is required where the rating means something is wrong."""
    if rating not in TRIAL_RATINGS:
        return f"unknown rating {rating!r}"
    if rating in ("impossible", "wrong_number") and not (note or "").strip():
        return "say why in a few words"
    return None


def trial_rating_rule(
    rating: str,
    note: str | None,
    *,
    role_node_id: uuid.UUID,
    role_title: str,
    metric_id: uuid.UUID | None,
    metric_name: str,
    fingerprint: str,
    existing: Iterable[ExistingRule],
) -> RuleProposal | None:
    """The rule a rating proposes, or None. Not relevant proposes a downweight of the measure for
    the role; Cannot act proposes a forbid on this exact problem. Useful and Wrong number propose
    nothing (a wrong number is a data problem to fix in Mapping, not a rule). Nothing is proposed
    when the same rule is already proposed or active. A person still accepts it in Rule review."""
    live = [
        r for r in existing if r.status in ("proposed", "active") and r.role_node_id == role_node_id
    ]
    why = (note or "").strip()
    if rating == "not_relevant" and metric_id is not None:
        if any(r.rule_type == "downweight" and r.metric_id == metric_id for r in live):
            return None
        text = f"Downweight {metric_name} for {role_title}: judged not relevant in the trial"
        return RuleProposal(
            role_node_id, "downweight", metric_id, None, f"{text}. {why}".strip(), []
        )
    if rating == "impossible":
        if any(r.rule_type == "forbid" and r.fingerprint == fingerprint for r in live):
            return None
        return RuleProposal(role_node_id, "forbid", metric_id, fingerprint, why, [])
    return None


# ---------------------------------------------------------------------------------------------
# Console insights (ADR 0025): what a workspace keeps rejecting, and where to look
# ---------------------------------------------------------------------------------------------

REJECTION_CATEGORIES = (
    ("not in evidence", "invented number"),
    ("not a decision this role owns", "action outside the role"),
    ("forbidden", "forbidden action"),
    ("same fingerprint", "already an open card"),
    ("duplicate", "duplicate card"),
    ("unknown signal", "unknown signal"),
)


def rejection_category(reason: str) -> str:
    """Group the validator's reasons ("what: number 61 not in evidence") into a few kinds."""
    low = reason.lower()
    return next((label for needle, label in REJECTION_CATEGORIES if needle in low), "other")


@dataclass(frozen=True)
class MetricFate:
    role: str
    metric: str
    actioned: int
    not_relevant: int
    impossible: int

    @property
    def decided(self) -> int:
        return self.actioned + self.not_relevant + self.impossible


@dataclass(frozen=True)
class WriterQuality:
    agent: str  # "card_writer_sales v1"
    written: int  # stored cards + validator rejections
    rejected: int
    top_reason: str | None


def _hint(kind: str, target: str, text: str) -> dict[str, str]:
    return {"kind": kind, "target": target, "text": text}


def hints(
    fates: list[MetricFate], writers: list[WriterQuality], rules: RulesConfig
) -> list[dict[str, str]]:
    """Plain-language pointers for the internal team, strongest first."""
    out: list[tuple[float, dict[str, str]]] = []
    for f in fates:
        if f.decided < rules.hint_min_cards:
            continue
        target = f"{f.role} · {f.metric}"
        rate = f.not_relevant / f.decided
        if rate >= rules.hint_not_relevant_rate:
            text = (
                f"{f.role} marked {f.not_relevant} of {f.decided} {f.metric} cards Not relevant. "
                "Raise this metric's threshold or lower its weight in Config & rules, "
                "or accept the downweight WF5 proposes."
            )
            out.append((rate, _hint("metric", target, text)))
        if f.impossible:
            text = (
                f"{f.role} found {f.impossible} {f.metric} actions impossible. Check the role's "
                "decisions owned and forbidden, and review the proposed forbid rules."
            )
            out.append((f.impossible / f.decided, _hint("metric", target, text)))
    for w in writers:
        if w.written < rules.hint_min_cards:
            continue
        rate = w.rejected / w.written
        if rate >= rules.hint_rejection_rate:
            reason = f", mostly {w.top_reason}" if w.top_reason else ""
            text = (
                f"The validator refused {w.rejected} of {w.written} drafts from {w.agent}{reason}. "
                "Draft a tighter prompt version in AI agents and evaluate it before activating."
            )
            out.append((rate, _hint("agent", w.agent, text)))
    return [h for _rate, h in sorted(out, key=lambda x: -x[0])]
