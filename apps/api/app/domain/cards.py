"""Card ranking and the open-card cap per role (spec: Pipeline step 7)."""

from dataclasses import dataclass
from decimal import Decimal


@dataclass(frozen=True)
class Ranked:
    key: str  # card id (existing) or signal id (new)
    score: float
    is_new: bool


@dataclass(frozen=True)
class StoragePlan:
    keep: list[str]  # every card that stays open (existing and new), best first = priority order
    accept: list[str]  # new card keys to store
    expire: list[str]  # existing open card ids pushed out by better cards
    over_cap: list[str]  # new card keys that did not make the cut


def score(expected_impact: Decimal | float, confidence: Decimal | float) -> float:
    return float(expected_impact) * float(confidence)


def plan_storage(existing: list[Ranked], new: list[Ranked], cap: int) -> StoragePlan:
    ranked = sorted([*existing, *new], key=lambda r: r.score, reverse=True)
    keep, drop = ranked[:cap], ranked[cap:]
    return StoragePlan(
        keep=[r.key for r in keep],
        accept=[r.key for r in keep if r.is_new],
        expire=[r.key for r in drop if not r.is_new],
        over_cap=[r.key for r in drop if r.is_new],
    )
