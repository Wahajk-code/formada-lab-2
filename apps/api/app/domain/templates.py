"""Render catalog SQL templates against a tenant's archetype mappings. Pure string work.

Placeholders: {{alias}} -> the mapped source (table or SELECT), {{alias.column}} -> physical column.
Values are never interpolated; they stay as %(name)s bind parameters.
"""

import re
from dataclasses import dataclass

_PLACEHOLDER = re.compile(r"\{\{\s*([a-z_][a-z0-9_]*)(?:\.([a-z_][a-z0-9_]*))?\s*\}\}")
_IDENTIFIER = re.compile(r"^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$")


class TemplateError(ValueError):
    pass


@dataclass(frozen=True)
class Mapping:
    source: str  # table name or a single SELECT
    columns: dict[str, str]  # logical -> physical


def render(sql: str, aliases: dict[str, str], mappings: dict[str, Mapping]) -> str:
    """aliases: template alias -> archetype key; mappings: archetype key -> tenant mapping."""

    def substitute(match: re.Match[str]) -> str:
        alias, column = match.group(1), match.group(2)
        if alias not in aliases:
            raise TemplateError(f"unknown alias {alias!r}")
        archetype = aliases[alias]
        if archetype not in mappings:
            raise TemplateError(f"tenant has no mapping for archetype {archetype!r}")
        mapping = mappings[archetype]
        if column is None:
            # Templates run with %(name)s bind parameters, so a literal % in the customer's
            # mapping (LIKE '%hold%') must be doubled or the driver reads it as a placeholder.
            return mapping.source.replace("%", "%%")
        physical = mapping.columns.get(column)
        if physical is None:
            raise TemplateError(f"{archetype} mapping lacks column {column!r}")
        if not _IDENTIFIER.match(physical):
            raise TemplateError(f"unsafe column identifier {physical!r}")
        return physical

    rendered = _PLACEHOLDER.sub(substitute, sql)
    if "{{" in rendered:
        raise TemplateError("unresolved placeholder")
    return rendered


def check_contract(sql: str) -> None:
    """Spec: aggregates only. Every template groups and carries the row cap."""
    lowered = " ".join(sql.lower().split())
    if "group by" not in lowered or "limit %(row_cap)s" not in lowered:
        raise TemplateError("template must GROUP BY and end with LIMIT %(row_cap)s")
