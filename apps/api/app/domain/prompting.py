"""Prompt assembly in the spec's order, stable parts first so the provider can cache the prefix:
system instructions, department playbook, role profile, active feedback rules, then signals."""

import json
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class RoleProfile:
    title: str
    department: str | None
    language: str
    decisions_owned: list[str]
    decisions_forbidden: list[str]
    kpi_notes: str | None


@dataclass(frozen=True)
class ActiveRule:
    rule_type: str  # downweight | forbid
    text: str


@dataclass(frozen=True)
class PromptSignal:
    signal_id: str
    metric_key: str
    kind: str
    entity: str
    direction: str
    evidence: dict[str, Any]


@dataclass(frozen=True)
class Prompt:
    system: str
    user: str


def _bullets(items: list[str]) -> str:
    return "\n".join(f"- {i}" for i in items) if items else "- (none)"


def build_prompt(
    system: str,
    playbook: str,
    profile: RoleProfile,
    rules: list[ActiveRule],
    signals: list[PromptSignal],
) -> Prompt:
    role_section = (
        f"# Role profile\n"
        f"Role: {profile.title}"
        + (f" ({profile.department})" if profile.department else "")
        + f"\nLanguage: {profile.language}\n"
        f"Decisions this role owns:\n{_bullets(profile.decisions_owned)}\n"
        f"Decisions this role cannot make:\n{_bullets(profile.decisions_forbidden)}\n"
        f"KPIs: {profile.kpi_notes or '-'}"
    )
    rules_section = "# Active feedback rules\n" + _bullets(
        [f"[{r.rule_type}] {r.text}" for r in rules]
    )
    signals_section = "# Signals for this run\n" + json.dumps(
        [s.__dict__ for s in signals], ensure_ascii=False, indent=1, default=str
    )
    user = "\n\n".join(
        [f"# Department playbook\n{playbook.strip()}", role_section, rules_section, signals_section]
    )
    return Prompt(system=system.strip(), user=user)
