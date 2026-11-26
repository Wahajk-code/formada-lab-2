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


def check_feedback(type_: str, reason: str | None) -> str | None:
    """Error message, or None if the feedback is valid (reason required for Impossible)."""
    if type_ not in FEEDBACK_TYPES:
        return f"unknown feedback type {type_!r}"
    if type_ == "impossible" and not (reason or "").strip():
        return "a reason is required for Impossible"
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
        elif f.type == "not_relevant" and f.metric_id is not None:
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
