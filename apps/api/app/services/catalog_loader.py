"""Load catalog/*.yaml (global, versioned) into Postgres. Upserts by key (and version)."""

from pathlib import Path
from typing import Any

import yaml
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.logging import get_logger
from app.models import Agent, AgentPrompt, DataArchetype, PromptTemplate, RoleArchetype, SqlTemplate

log = get_logger(__name__)


def _read(directory: Path) -> list[dict[str, Any]]:
    if not directory.is_dir():
        return []
    return [yaml.safe_load(p.read_text(encoding="utf-8")) for p in sorted(directory.glob("*.yaml"))]


async def load_catalog(session: AsyncSession, root: Path) -> dict[str, int]:
    counts: dict[str, int] = {}

    rows = _read(root / "role_archetypes")
    for doc in rows:
        definition = {k: v for k, v in doc.items() if k not in ("key", "version", "playbook")}
        stmt = insert(RoleArchetype).values(
            key=doc["key"], version=doc["version"], playbook=doc["playbook"], definition=definition
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[RoleArchetype.key],
                set_={"version": stmt.excluded.version, "definition": stmt.excluded.definition},
            )
        )
    counts["role_archetypes"] = len(rows)

    rows = _read(root / "archetypes")
    for doc in rows:
        stmt = insert(DataArchetype).values(
            key=doc["key"],
            version=doc["version"],
            description=doc["description"],
            columns=doc["columns"],
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[DataArchetype.key],
                set_={
                    "version": stmt.excluded.version,
                    "description": stmt.excluded.description,
                    "columns": stmt.excluded.columns,
                },
            )
        )
    counts["archetypes"] = len(rows)

    rows = _read(root / "sql_templates")
    for doc in rows:
        stmt = insert(SqlTemplate).values(
            key=doc["key"],
            version=doc["version"],
            playbook=doc["playbook"],
            aliases=doc["archetypes"],
            description=doc["description"],
            sql=doc["sql"],
            drivers=doc.get("drivers", {}),
            params_schema=doc.get("params", {}),
        )
        # A published (key, version) is immutable; change the SQL by bumping the version.
        await session.execute(stmt.on_conflict_do_nothing(index_elements=["key", "version"]))
    counts["sql_templates"] = len(rows)

    rows = _read(root / "prompts")
    for doc in rows:
        stmt = insert(PromptTemplate).values(
            key=doc["key"], version=doc["version"], body=doc["body"]
        )
        await session.execute(
            stmt.on_conflict_do_update(
                index_elements=[PromptTemplate.key],
                set_={"version": stmt.excluded.version, "body": stmt.excluded.body},
            )
        )
    counts["prompts"] = len(rows)

    # Agents (ADR 0022): created once; prompt versions are immutable. The console's choices
    # (active version, model override, examples on/off) are never overwritten by a reload.
    bodies = {doc["key"]: doc["body"] for doc in rows}
    agents = [a for doc in _read(root / "agents") for a in doc["agents"]]
    for a in agents:
        await session.execute(
            insert(Agent)
            .values(
                key=a["key"], name=a["name"], kind=a["kind"], playbook=a.get("playbook"),
                description=a["description"],
                active_version=max(v["version"] for v in a["versions"]),  # newest on first load
                model_override=a.get("model_override"),
            )
            .on_conflict_do_nothing(index_elements=[Agent.key])
        )  # fmt: skip
        for v in a["versions"]:
            body = v.get("body") or bodies[v["body_from"]]
            await session.execute(
                insert(AgentPrompt)
                .values(
                    agent_key=a["key"], version=v["version"], body=body, notes=v.get("notes", "")
                )
                .on_conflict_do_nothing(index_elements=["agent_key", "version"])
            )
    counts["agents"] = len(agents)

    log.info("catalog.loaded", **counts)
    return counts
