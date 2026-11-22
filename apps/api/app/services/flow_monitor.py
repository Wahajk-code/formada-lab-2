"""Watch the flows run, workspace by workspace (ADR 0034).

A run records a row for every step it takes (`run_step`), so the console can draw a run on its
flow's diagram: each step done, running, failed or not reached, and for the role steps how many
roles are through. Read-only. The pure rules are in `domain/flows.py` (`node_state`, `run_nodes`).
"""

import uuid
from typing import Any

from sqlalchemy import func, select

from app.core.db import global_tx, tenant_tx
from app.core.errors import NotFound
from app.domain import flows as fl
from app.models import RoleMetric, RoleNode, Run, RunStep, Tenant

LABEL = {key: step.label for key, step in fl.STEPS.items()}


def flow_of(run_type: str) -> fl.Flow:
    return next(f for f in fl.FLOWS.values() if f.run_type == run_type)


async def _roles_expected(s: Any, run: Run, rows: list[tuple[str | None, str, str]]) -> int:
    """How many roles the run covers: a weekly run covers every role with metrics, a daily check the
    roles its plan picked, the others none."""
    if run.type == "weekly":
        return int(await s.scalar(select(func.count(func.distinct(RoleMetric.role_node_id)))) or 0)
    if run.type == "daily_check":
        return len({r for r, key, _ in rows if key == "daily_plan" and r})
    return 0


async def _load(s: Any, run: Run) -> tuple[list[tuple[str | None, str, str]], int, dict[str, str]]:
    found = (
        await s.execute(
            select(RunStep.role_node_id, RunStep.step, RunStep.status).where(
                RunStep.run_id == run.id
            )
        )
    ).all()
    rows = [(str(r) if r else None, step, status) for r, step, status in found]
    titles = {str(i): t for i, t in (await s.execute(select(RoleNode.id, RoleNode.title))).all()}
    return rows, await _roles_expected(s, run, rows), titles


def _run_view(run: Run) -> dict[str, Any]:
    return {
        "id": str(run.id),
        "type": run.type,
        "status": run.status,
        "started_at": run.started_at.isoformat(),
        "ended_at": run.ended_at.isoformat() if run.ended_at else None,
        "error": run.error,
        "by_hand": bool(run.n8n_execution_id and run.n8n_execution_id != fl.SCHEDULED),
    }


async def run_state(tenant_id: uuid.UUID, run_id: uuid.UUID) -> dict[str, Any]:
    """One run on its flow: the state of every step, and for the role steps each role's progress."""
    async with tenant_tx("service", tenant_id) as s:
        run = await s.get(Run, run_id)
        if run is None:
            raise NotFound("run")
        rows, expected, titles = await _load(s, run)
        tenant = await s.get(Tenant, tenant_id)
    flow = flow_of(run.type)
    role_steps = [st.key for st in flow.role_steps]
    by_role: dict[str, dict[str, str]] = {}
    for role, key, status in rows:
        if role and key in role_steps:
            by_role.setdefault(role, {})[key] = status
    return {
        "flow": flow.key,
        "workspace": {"id": str(tenant_id), "name": tenant.name if tenant else ""},
        "run": _run_view(run),
        "roles_expected": expected,
        "nodes": fl.run_nodes(flow, run.status, rows, expected),
        "roles": sorted(
            (
                {"id": r, "title": titles.get(r, "role"), "steps": steps}
                for r, steps in by_role.items()
            ),
            key=lambda x: str(x["title"]),
        ),
    }


async def board(flow_key: str) -> dict[str, Any]:
    """Every workspace with the latest run of this flow and how far it has got."""
    flow = fl.FLOWS.get(flow_key)
    if flow is None or flow.run_type is None:
        raise NotFound("flow")
    async with global_tx("service") as s:
        tenants = (await s.scalars(select(Tenant).order_by(Tenant.name))).all()
    out: list[dict[str, Any]] = []
    for t in tenants:
        async with tenant_tx("service", t.id) as s:
            run = await s.scalar(
                select(Run)
                .where(Run.type == flow.run_type)
                .order_by(Run.started_at.desc())
                .limit(1)
            )
            if run is None:
                out.append(
                    {"workspace": {"id": str(t.id), "name": t.name}, "run": None, "progress": None}
                )
                continue
            rows, expected, _ = await _load(s, run)
        nodes = fl.run_nodes(flow, run.status, rows, expected)
        states = [str(n["state"]) for n in nodes.values()]
        current = next((LABEL[k] for k, n in nodes.items() if n["state"] == "running"), None)
        role = next(
            (n for k, n in nodes.items() if k in {x.key for x in flow.role_steps} and n["total"]),
            None,
        )
        out.append(
            {
                "workspace": {"id": str(t.id), "name": t.name},
                "run": _run_view(run),
                "progress": {
                    "steps_done": sum(s in ("ok", "skipped", "partial", "failed") for s in states),
                    "steps_total": len(states),
                    "current": current,
                    "problems": sum(s in ("failed", "partial") for s in states),
                    "roles_total": int(role["total"]) if role else 0,
                    "roles_done": int(
                        max(
                            (
                                n["done"]
                                for k, n in nodes.items()
                                if k in {x.key for x in flow.role_steps}
                            ),
                            default=0,
                        )
                    ),
                },
            }
        )
    return {"flow": flow_key, "workspaces": out}
