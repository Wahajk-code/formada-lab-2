"""Run scheduling and status rules (ADR 0009, 0019).

All slots are in the tenant's time zone (spec: workflows; ADR 0034):
  weekly       Monday 05:00            WF1
  daily_check  daily 05:00, not Monday WF2 (Monday has the full weekly run)
  remeasure    daily 06:00             WF3
  digest       Monday 08:00            WF4
"""

import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

WEEKLY_RUN_WEEKDAY = 0  # Monday
WEEKLY_RUN_TIME = time(5, 0)
DAILY_CHECK_TIME = time(5, 0)
REMEASURE_TIME = time(6, 0)
DIGEST_TIME = time(8, 0)
SCHEDULED_TYPES = ("weekly", "daily_check", "remeasure", "digest")


def weekly_slot(now: datetime, timezone: str, at: time = WEEKLY_RUN_TIME) -> datetime:
    """This week's Monday at `at` in the tenant's time zone (may be in the future)."""
    local = now.astimezone(ZoneInfo(timezone))
    monday = local.date() - timedelta(days=local.weekday() - WEEKLY_RUN_WEEKDAY)
    return datetime.combine(monday, at, tzinfo=ZoneInfo(timezone))


def daily_slot(now: datetime, timezone: str, at: time) -> datetime:
    local = now.astimezone(ZoneInfo(timezone))
    return datetime.combine(local.date(), at, tzinfo=ZoneInfo(timezone))


def current_slot(kind: str, now: datetime, timezone: str) -> datetime | None:
    """The slot of this kind for now (may be in the future); None if there is none today."""
    if kind == "weekly":
        return weekly_slot(now, timezone)
    if kind == "digest":
        return weekly_slot(now, timezone, DIGEST_TIME)
    if kind == "remeasure":
        return daily_slot(now, timezone, REMEASURE_TIME)
    if kind == "daily_check":
        slot = daily_slot(now, timezone, DAILY_CHECK_TIME)
        return None if slot.weekday() == WEEKLY_RUN_WEEKDAY else slot
    raise ValueError(f"unknown schedule {kind!r}")


def due(kind: str, now: datetime, timezone: str, last_success: datetime | None) -> datetime | None:
    """The slot to run now, or None. Catches up when an earlier tick was missed or failed."""
    slot = current_slot(kind, now, timezone)
    if slot is None or now < slot:
        return None
    if last_success is not None and last_success >= slot:
        return None
    return slot


def weekly_due(now: datetime, timezone: str, last_success_slot: datetime | None) -> datetime | None:
    return due("weekly", now, timezone, last_success_slot)


def period_end(slot: datetime, run_type: str = "weekly") -> date:
    """Data period a run covers: through the Sunday before the slot for weekly runs, through
    yesterday for daily ones."""
    if run_type == "weekly":
        return slot.date() - timedelta(days=slot.weekday() + 1)
    return slot.date() - timedelta(days=1)


@dataclass(frozen=True)
class DailyCheck:
    """Latest value per entity of one daily_check metric on a role, with its threshold."""

    metric_key: str
    threshold: float | None
    higher_is_better: bool
    latest: dict[str, float]


@dataclass(frozen=True)
class DailyRole:
    role_node_id: uuid.UUID
    title: str
    cadence: str
    checks: list[DailyCheck]


def daily_plan(roles: Iterable[DailyRole]) -> list[tuple[DailyRole, str]]:
    """Roles a daily check runs the role pipeline for (spec WF2): every daily-cadence role, and
    any role whose daily_check metric breaches its threshold for some entity."""
    plan = []
    for role in roles:
        if role.cadence == "daily":
            plan.append((role, "daily cadence"))
            continue
        for check in role.checks:
            if check.threshold is None:
                continue
            hit = [
                e
                for e, v in check.latest.items()
                if (v < check.threshold if check.higher_is_better else v > check.threshold)
            ]
            if hit:
                plan.append((role, f"{check.metric_key} threshold breach: {', '.join(hit[:3])}"))
                break
    return plan


def run_status(step_statuses: Iterable[str]) -> str:
    statuses = list(step_statuses)
    if not statuses or all(s in ("ok", "skipped") for s in statuses):
        return "succeeded"
    if all(s == "failed" for s in statuses):
        return "failed"
    return "partial"
