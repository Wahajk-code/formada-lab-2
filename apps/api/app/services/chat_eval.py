"""Compare prompt versions of the workspace chat on a fixed set of questions (docs/chat-evals.md).

Every question goes through the same code path as the real chat (`team_context_for` and
`_call_full`), once per prompt version, and each answer is scored by the rules in
`domain/chat_eval.py`. Nothing is written: the run only reads the workspace and calls the AI, and
the AI calls cost money, so `plan` shows what a run would cost before `run` is allowed."""

import json
import time
from pathlib import Path
from typing import Any

import yaml

from app.domain import chat_eval as ev
from app.domain import discovery_cards as dc
from app.domain.llm import estimated_cost
from app.services import assistant

CASES_FILE = Path(__file__).resolve().parents[4] / "catalog" / "evals" / "workspace_assistant.yaml"
CHARS_PER_TOKEN = 4  # a rough rule for English and JSON text, enough for a cost estimate
EXPECTED_OUTPUT_TOKENS = 400


def load_cases(path: Path = CASES_FILE) -> list[dict[str, Any]]:
    data = yaml.safe_load(path.read_text(encoding="utf-8"))
    cases: list[dict[str, Any]] = data["cases"]
    for c in cases:
        unknown = [k for k in c.get("checks", []) if k not in ev.CHECKS]
        if unknown:
            raise ValueError(f"case {c['id']}: unknown check {unknown[0]}")
    return cases


def attachment(kind: str, ctx: dict[str, Any]) -> list[tuple[str, str]]:
    """What to attach for a case, as (id, label) pairs, from this workspace's own context. Empty
    when the workspace has nothing of that kind, so the case is skipped."""
    guide = ctx.get("data_guide") or {}
    links: list[dict[str, Any]] = ctx.get("links") or []
    if kind == "none":
        return []
    if kind == "mapping_field_low":
        for level in ("low", "medium", "high"):
            for link in links:
                for f in link.get("fields", []):
                    if f.get("confidence") == level and f.get("from"):
                        shape = link["standard_shape"]
                        return [(f"m:{shape}.{f['field']}", f"{shape}: {f['field']}")]
        return []
    if kind == "mapping_link":
        ordered = sorted(links, key=lambda x: not x.get("questions"))
        return (
            [(f"m:{ordered[0]['standard_shape']}", str(ordered[0]["standard_shape"]))]
            if ordered
            else []
        )
    if kind == "issue":
        issues = guide.get("quality_issues") or []
        return [(f"i:{dc.slug(issues[0]['title'])}", str(issues[0]["title"]))] if issues else []
    if kind == "table":
        tables = guide.get("tables") or []
        return (
            [(f"t:{tables[0]['table']}", str(tables[0]["table"]).split(".")[-1])] if tables else []
        )
    if kind == "history":
        profile = ctx.get("warehouse_profile") or {}
        return [("f:history", "The main table over time")] if profile.get("time_profile") else []
    raise ValueError(f"unknown attachment {kind}")


async def plan(tenant_id: Any, versions: list[int], cases: list[dict[str, Any]]) -> dict[str, Any]:
    """What a run would do and cost, without calling the AI."""
    base, _ = await assistant.team_context_for(tenant_id, [])
    size = len(json.dumps(base, default=str)) // CHARS_PER_TOKEN
    runnable = [
        c for c in cases if c.get("attach", "none") == "none" or attachment(c["attach"], base)
    ]
    skipped = [c["id"] for c in cases if c not in runnable]
    calls = len(runnable) * len(versions)
    tokens_in = calls * size
    return {"runnable": [c["id"] for c in runnable], "skipped": skipped, "calls": calls,
            "context_tokens": size, "input_tokens": tokens_in,
            "output_tokens": calls * EXPECTED_OUTPUT_TOKENS}  # fmt: skip


async def run(tenant_id: Any, versions: list[int], cases: list[dict[str, Any]]) -> dict[str, Any]:
    """Ask every runnable case once per version and score the answers."""
    base, _ = await assistant.team_context_for(tenant_id, [])
    results: dict[str, dict[str, dict[str, bool]]] = {f"v{v}": {} for v in versions}
    answers: dict[str, dict[str, dict[str, Any]]] = {f"v{v}": {} for v in versions}
    skipped: list[str] = []
    spent: dict[str, float] = {f"v{v}": 0.0 for v in versions}
    for case in cases:
        attached = attachment(case.get("attach", "none"), base)
        if case.get("attach", "none") != "none" and not attached:
            skipped.append(case["id"])
            continue
        ids = [i for i, _ in attached]
        labels = [label for _, label in attached]
        ctx, _missing = await assistant.team_context_for(tenant_id, ids)
        question = ev.question_with_mentions(case["question"], labels)
        for v in versions:
            t0 = time.monotonic()
            out, used = await assistant._call_full(
                tenant_id, "team", case["step"], question, ctx, [], version=v
            )
            check = assistant._check(out, ctx)
            measured = {
                "unverified": check["unverified"],
                "grounded": check["grounded"],
                "attached_labels": labels,
            }
            key = f"v{v}"
            results[key][case["id"]] = ev.evaluate(case, out.answer, measured, ctx)
            cost = (
                estimated_cost(used["model"] or "", used["input_tokens"] + used["output_tokens"])
                or 0.0
            )
            spent[key] += cost
            answers[key][case["id"]] = {"answer": out.answer, "unverified": check["unverified"],
                                        "seconds": round(time.monotonic() - t0, 1),
                                        "cost_usd": round(cost, 4)}  # fmt: skip
    summary = ev.summarize(results)
    names = list(results)
    verdict = ev.verdict(summary, names[0], names[-1]) if len(names) > 1 else None
    return {"summary": summary, "verdict": verdict, "skipped": skipped, "answers": answers,
            "checks": results, "cost_usd": {k: round(x, 4) for k, x in spent.items()}}  # fmt: skip


def report(outcome: dict[str, Any]) -> str:
    """The run as plain text: totals, what changed between versions, and every failed check."""
    s = outcome["summary"]
    lines = ["Totals (checks passed):"]
    for v, t in s["totals"].items():
        lines.append(
            f"  {v}: {t['passed']} of {t['checks']}   cost US${outcome['cost_usd'][v]:.2f}"
        )
    if outcome["skipped"]:
        lines.append(
            f"Skipped (this workspace has nothing to attach): {', '.join(outcome['skipped'])}"
        )
    lines.append("")
    lines.append(
        "Where the versions differ:" if s["differences"] else "The versions pass the same checks."
    )
    for d in s["differences"]:
        votes = ", ".join(f"{k}={'pass' if d[k] else 'FAIL'}" for k in s["totals"])
        lines.append(f"  {d['case']} / {d['check']}: {votes}")
    for v, per_case in outcome["checks"].items():
        failed = [(cid, k) for cid, res in per_case.items() for k, ok in res.items() if not ok]
        if failed:
            lines.append("")
            lines.append(f"{v} fails:")
            lines.extend(f"  {cid}: {ev.CHECKS[k]}" for cid, k in failed)
    if outcome["verdict"]:
        lines.append("")
        lines.append(f"Verdict: {outcome['verdict']}")
    return chr(10).join(lines)
