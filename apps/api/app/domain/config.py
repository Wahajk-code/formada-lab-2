# ruff: noqa: E501
"""Every tunable business number, with its allowed range (ADR 0020).

The SCHEMA table keeps one setting per line for readability (E501 off for this file).

Layers, last wins: code default (here) -> system override (internal team, all workspaces) ->
workspace override (internal team, one client). Per-role thresholds and weights live on
role_metric. Pure: no I/O; services load the overrides and call layered().
"""

from dataclasses import dataclass, fields, replace
from typing import Any


@dataclass(frozen=True)
class RulesConfig:
    # Cards
    max_open_cards_per_role: int = 5
    card_expiry_days: int = 28
    rollup_top_n: int = 3
    # Detection
    trailing_weeks: int = 13
    recent_weeks: int = 3
    recent_exceed_min: int = 2
    min_baseline_points: int = 4
    zscore_threshold: float = 2.0
    wow_change_threshold_pct: float = 15.0
    wow_min_level_z: float = 1.0
    min_weeks_of_history: int = 8
    min_signal_impact: float = 1000.0
    # Filtering
    top_signals_per_role: int = 8
    # Each measure with a problem gets its strongest one into the list before money ranks the rest.
    min_signals_per_metric: int = 2
    # Items behind each problem the card writer sees (row-level detail, aggregated per item).
    top_items_per_problem: int = 10
    not_relevant_suppress_days: int = 56
    downweight_factor: float = 0.5
    # Feedback loop: Not relevant on the same metric for one role before a downweight is proposed
    not_relevant_for_downweight: int = 3
    # AI agents: feedback examples shown to the card writer (ADR 0022)
    agent_examples_max: int = 4
    agent_examples_days: int = 180
    # Onboarding: share of mapped rows allowed to repeat their grain before the mapping is refused
    mapping_grain_tolerance_pct: float = 0.5
    mapping_sku_overlap_min_pct: float = 60.0
    # Onboarding discovery: join tests per warehouse and the share of values a join must find
    discovery_join_probe_budget: int = 40
    discovery_join_min_overlap_pct: float = 90.0
    # Mapping health at the start of each run: change versus the approved mapping that raises a warning
    mapping_health_rows_change_pct: float = 30.0
    mapping_health_fill_drop_pts: float = 20.0
    # Initiatives and outcomes
    min_window_days: int = 30
    max_window_days: int = 120
    outcome_midpoint_fraction: float = 0.5
    # Weekly digest: cards newer than this are "new"
    digest_lookback_days: int = 7
    # Runs
    max_concurrent_runs_per_tenant: int = 2
    query_timeout_seconds: int = 300
    query_row_cap: int = 500
    llm_log_retention_days: int = 90
    # Access: invites and in-app sign-in (ADR 0023)
    invite_valid_days: int = 14
    password_min_length: int = 10
    login_max_attempts: int = 5
    login_lockout_minutes: int = 15
    password_reset_valid_minutes: int = 60
    # Console feedback hints (ADR 0025): when a metric or a card writer needs a look
    hint_not_relevant_rate: float = 0.5
    hint_rejection_rate: float = 0.3
    hint_min_cards: int = 3

    def with_overrides(self, overrides: dict[str, Any]) -> "RulesConfig":
        known = {f.name: f.type for f in fields(self)}
        clean = {k: v for k, v in overrides.items() if k in known}
        return replace(self, **clean)


DEFAULTS = RulesConfig()

# How much a client hears, as three presets (ADR 0029). The client picks one in plain words
# ("Fewer", "Balanced", "More"); our team applies it as these settings. Store-level problems in a
# retail business are often a few hundred dollars, so Balanced lets them through.
PRESETS: dict[str, dict[str, float | int]] = {
    "fewer": {"min_signal_impact": 1000.0, "max_open_cards_per_role": 3, "top_signals_per_role": 5},
    "balanced": {
        "min_signal_impact": 250.0,
        "max_open_cards_per_role": 5,
        "top_signals_per_role": 8,
    },
    "more": {"min_signal_impact": 100.0, "max_open_cards_per_role": 8, "top_signals_per_role": 12},
}


@dataclass(frozen=True)
class Setting:
    group: str
    label: str
    help: str
    minimum: float
    maximum: float
    unit: str = ""


# What the console shows and validates. Every RulesConfig field has an entry (a unit test checks).
SCHEMA: dict[str, Setting] = {
    "max_open_cards_per_role": Setting("cards", "Open cards per role", "A role never sees more open cards than this; weaker ones expire.", 1, 20, "cards"),
    "card_expiry_days": Setting("cards", "Card expiry", "Open cards without action expire after this many days.", 7, 120, "days"),
    "rollup_top_n": Setting("cards", "Roll-up size", "How many of the team's top cards a parent role sees.", 0, 10, "cards"),
    "trailing_weeks": Setting("detection", "Baseline window", "Weeks of history before the recent window that define normal.", 4, 52, "weeks"),
    "recent_weeks": Setting("detection", "Recent window", "Latest weeks whose mean is tested against the baseline.", 1, 8, "weeks"),
    "recent_exceed_min": Setting("detection", "Recent weeks that must agree", "How many recent weeks must be past baseline +/- 1 sd.", 1, 8, "weeks"),
    "min_baseline_points": Setting("detection", "Minimum baseline points", "Fewer points than this and no z-score is computed.", 2, 26, "points"),
    "zscore_threshold": Setting("detection", "z-score threshold", "A sustained shift needs a z-score beyond this.", 1.0, 5.0, "sd"),
    "wow_change_threshold_pct": Setting("detection", "Week-over-week threshold", "Minimum move since last week for a week-over-week signal.", 5.0, 100.0, "%"),
    "wow_min_level_z": Setting("detection", "Week-over-week level check", "A week-over-week jump also needs a level move of this many sd.", 0.0, 3.0, "sd"),
    "min_weeks_of_history": Setting("detection", "Minimum history", "Entities with fewer weeks of data are skipped.", 4, 52, "weeks"),
    "min_signal_impact": Setting("detection", "Materiality floor", "Signals with a smaller estimated impact are dropped.", 0.0, 100000.0, "CAD"),
    "top_items_per_problem": Setting("filtering", "Top items per problem", "Items behind each problem shown to the card writer, so cards can name what to act on. 0 sends totals only.", 0, 25, "items"),
    "top_signals_per_role": Setting("filtering", "Signals per role", "Strongest signals passed to the card writer per run.", 1, 20, "signals"),
    "min_signals_per_metric": Setting("filtering", "Room for every measure", "Each measure's strongest problem is kept before money ranks the rest, so a small but real problem (backorders, late suppliers) is not crowded out by big stock numbers. 0 ranks by money only.", 0, 5, "signals"),
    "not_relevant_suppress_days": Setting("filtering", "Not relevant suppression", "How long a Not relevant hides the same signal from the role.", 7, 365, "days"),
    "downweight_factor": Setting("filtering", "Downweight factor", "Score multiplier for a metric with an active downweight rule.", 0.0, 1.0, "x"),
    "not_relevant_for_downweight": Setting("feedback", "Not relevant before a downweight", "Not relevant on one metric for one role before a downweight is proposed.", 1, 20, "times"),
    "agent_examples_max": Setting("agents", "Feedback examples per prompt", "Past actioned and rejected cards shown to the card writer.", 0, 12, "examples"),
    "agent_examples_days": Setting("agents", "Example look-back", "Only feedback newer than this becomes an example.", 7, 730, "days"),
    "mapping_sku_overlap_min_pct": Setting("agents", "Item codes shared by mappings", "Share of recently sold item codes that must also appear in the stock and purchase mappings, or the mapping is refused (the shapes could not be joined by item).", 0, 100, "%"),
    "mapping_grain_tolerance_pct": Setting("agents", "Repeated rows in a mapping", "Share of a mapped source's rows allowed to repeat their grain (item, location, date) before onboarding refuses it.", 0, 20, "%"),
    "discovery_join_probe_budget": Setting("agents", "Join tests in discovery", "How many candidate joins discovery tests against the data (one query each).", 0, 200, "tests"),
    "discovery_join_min_overlap_pct": Setting("agents", "Join overlap to confirm", "Share of a column's values that must exist on the key side before a join counts as confirmed.", 50, 100, "%"),
    "mapping_health_rows_change_pct": Setting("runs", "Mapping row change", "A run warns when a mapped source has this much more or fewer rows than when it was approved.", 5, 200, "%"),
    "mapping_health_fill_drop_pts": Setting("runs", "Mapping fill drop", "A run warns when a mapped field is this many points emptier than when it was approved.", 5, 100, "pts"),
    "min_window_days": Setting("outcomes", "Shortest window", "Minimum measurement window for an initiative.", 7, 365, "days"),
    "max_window_days": Setting("outcomes", "Longest window", "Maximum measurement window for an initiative.", 14, 730, "days"),
    "outcome_midpoint_fraction": Setting("outcomes", "Midpoint position", "When the interim measurement happens, as a share of the window.", 0.1, 0.9, "x"),
    "digest_lookback_days": Setting("digest", "Digest look-back", "Cards newer than this count as new in the weekly email.", 1, 31, "days"),
    "max_concurrent_runs_per_tenant": Setting("runs", "Concurrent runs", "Runs at the same time per workspace (spec: 2).", 1, 5, "runs"),
    "query_timeout_seconds": Setting("runs", "Query timeout", "Per-template timeout in the warehouse (spec: 300 s).", 30, 1800, "s"),
    "query_row_cap": Setting("runs", "Row cap", "Maximum rows a template may return (spec: 500).", 50, 5000, "rows"),
    "llm_log_retention_days": Setting("runs", "AI log retention", "Raw prompts and responses are purged after this (spec: 90 days).", 7, 365, "days"),
    "invite_valid_days": Setting("access", "Invite validity", "An invite link expires after this many days.", 1, 60, "days"),
    "password_min_length": Setting("access", "Minimum password length", "Shortest password a person or staff member may set.", 8, 64, "chars"),
    "login_max_attempts": Setting("access", "Failed sign-ins before lockout", "Wrong passwords in a row before the account is locked for a while.", 3, 20, "tries"),
    "login_lockout_minutes": Setting("access", "Lockout duration", "How long a locked account waits before it can try again.", 1, 1440, "min"),
    "password_reset_valid_minutes": Setting("access", "Reset link validity", "A password reset link expires after this many minutes.", 10, 1440, "min"),
    "hint_not_relevant_rate": Setting("feedback", "Hint: Not relevant rate", "Console flags a metric for a role when this share of its decided cards was Not relevant.", 0.1, 1.0, "x"),
    "hint_rejection_rate": Setting("feedback", "Hint: validator rejection rate", "Console flags a card writer when this share of its drafts is refused by the validator.", 0.05, 1.0, "x"),
    "hint_min_cards": Setting("feedback", "Hint: minimum cards", "Hints need at least this many cards, so one bad week does not raise a flag.", 1, 50, "cards"),
}  # fmt: skip

# The same settings in one plain sentence each, shown first in the console (ADR 0029). The
# SCHEMA help above is the detail. A unit test checks every setting has one.
SIMPLE: dict[str, str] = {
    "max_open_cards_per_role": "How many cards one person can have open at once.",
    "card_expiry_days": "How long a card waits for an answer before it closes by itself.",
    "rollup_top_n": "How many of their team's cards a manager also sees.",
    "trailing_weeks": "How many weeks of history define 'usual'.",
    "recent_weeks": "How many of the latest weeks are compared with usual.",
    "recent_exceed_min": "How many of those latest weeks must be off before we call it a trend.",
    "min_baseline_points": "The fewest weeks of history needed to judge a trend.",
    "zscore_threshold": "How far from usual a number must move to count as a problem.",
    "wow_change_threshold_pct": "How big a jump since last week must be to count.",
    "wow_min_level_z": "A weekly jump must also be away from usual, not just noise.",
    "min_weeks_of_history": "Locations or items with less history than this are skipped.",
    "min_signal_impact": "The smallest problem, in money, worth a card.",
    "top_items_per_problem": "How many items a card can name (e.g. the 10 products behind a pile-up).",
    "top_signals_per_role": "How many problems per person the card writer looks at each week.",
    "min_signals_per_metric": "Each kind of problem gets a place on the list before the biggest amounts fill the rest.",
    "not_relevant_suppress_days": "How long a 'Not relevant' answer keeps the same card away.",
    "downweight_factor": "How much a down-ranked measure's problems are pushed down the list.",
    "not_relevant_for_downweight": "How many 'Not relevant' answers before we propose down-ranking.",
    "agent_examples_max": "How many past answered cards the card writer learns from.",
    "agent_examples_days": "How old a past answer can be to still teach the card writer.",
    "mapping_sku_overlap_min_pct": "How many sold items must also appear in stock and purchasing before we trust the item codes.",
    "mapping_grain_tolerance_pct": "How many repeated rows a mapping may have before we call it a bad join.",
    "discovery_join_probe_budget": "How many joins we test against the customer's data during discovery.",
    "discovery_join_min_overlap_pct": "How well two columns must match before we call them a real join.",
    "mapping_health_rows_change_pct": "How big a jump in a customer's row counts we flag before computing metrics.",
    "mapping_health_fill_drop_pts": "How much emptier a mapped field can get before we flag it.",
    "min_window_days": "The shortest time we measure an action's result.",
    "max_window_days": "The longest time we measure an action's result.",
    "outcome_midpoint_fraction": "When the halfway check of an action's result happens.",
    "digest_lookback_days": "Which cards the weekly email calls new.",
    "max_concurrent_runs_per_tenant": "How many runs one workspace can have going at once.",
    "query_timeout_seconds": "How long one warehouse query may run before we stop it.",
    "query_row_cap": "The most rows one measure may read from the warehouse.",
    "llm_log_retention_days": "How long we keep the AI's raw prompts and answers.",
    "invite_valid_days": "How long an invite link works.",
    "password_min_length": "The shortest password allowed.",
    "login_max_attempts": "Wrong passwords in a row before the account locks.",
    "login_lockout_minutes": "How long a locked account waits.",
    "password_reset_valid_minutes": "How long a password reset link works.",
    "hint_not_relevant_rate": "When the console flags a measure people keep calling 'Not relevant'.",
    "hint_rejection_rate": "When the console flags a card writer whose cards keep failing checks.",
    "hint_min_cards": "How many cards are needed before those flags appear.",
}

GROUPS = (
    "detection",
    "filtering",
    "cards",
    "feedback",
    "agents",
    "outcomes",
    "digest",
    "runs",
    "access",
)


def coerce(key: str, value: Any) -> Any:
    """The value converted to the field's type and checked against its range. ValueError if not."""
    if key not in SCHEMA:
        raise ValueError(f"unknown setting {key!r}")
    setting = SCHEMA[key]
    is_int = isinstance(getattr(DEFAULTS, key), int)
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{key} must be a number") from exc
    if is_int and number != int(number):
        raise ValueError(f"{key} must be a whole number")
    if not setting.minimum <= number <= setting.maximum:
        raise ValueError(f"{key} must be between {setting.minimum:g} and {setting.maximum:g}")
    return int(number) if is_int else number


def layered(system: dict[str, Any], workspace: dict[str, Any]) -> RulesConfig:
    return DEFAULTS.with_overrides(system).with_overrides(workspace)


def check_consistency(cfg: RulesConfig) -> list[str]:
    """Cross-field rules a single range cannot express."""
    problems = []
    if cfg.recent_exceed_min > cfg.recent_weeks:
        problems.append("recent weeks that must agree cannot exceed the recent window")
    if cfg.min_window_days > cfg.max_window_days:
        problems.append("shortest window cannot exceed the longest window")
    if cfg.min_baseline_points > cfg.trailing_weeks:
        problems.append("minimum baseline points cannot exceed the baseline window")
    return problems


def describe(
    system: dict[str, Any], workspace: dict[str, Any] | None = None
) -> list[dict[str, Any]]:
    """One row per setting with every layer and where the effective value comes from."""
    rows = []
    for f in fields(RulesConfig):
        s = SCHEMA[f.name]
        default = getattr(DEFAULTS, f.name)
        sys_v = system.get(f.name)
        ws_v = (workspace or {}).get(f.name)
        effective = ws_v if ws_v is not None else sys_v if sys_v is not None else default
        source = "workspace" if ws_v is not None else "system" if sys_v is not None else "default"
        rows.append(
            {
                "key": f.name,
                "group": s.group,
                "label": s.label,
                "help": s.help,
                "simple": SIMPLE.get(f.name, s.help),
                "unit": s.unit,
                "min": s.minimum,
                "max": s.maximum,
                "integer": isinstance(default, int),
                "default": default,
                "system": sys_v,
                "workspace": ws_v,
                "effective": effective,
                "source": source,
            }
        )
    return rows
