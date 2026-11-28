"""Validation and accuracy (docs/how-we-validate.md): the evidence our numbers and AI are right.

Five things, one place:

1. Control totals: figures the client already trusts, compared with our own on every run.
2. Backtest: detection replayed on a client's own history, week by week, with their known incidents.
3. Stability: an AI step asked twice on the same input; the decisions should agree.
4. Regression: a prompt version replayed on an input whose answer the team approved.
5. The accuracy picture: all of the above plus the owners' feedback, in one place per client.

All of it is read-only on the customer's warehouse (it only reads what runs already stored). The
tests that call the AI cost money and say what they cost. Results are kept in `validation_result`.
"""

import uuid
from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from typing import Any

from sqlalchemy import select

from app.core.db import tenant_tx
from app.core.errors import Conflict, Invalid, NotFound
from app.core.logging import get_logger
from app.domain import accuracy, backtest, reconcile, stability
from app.domain import feedback as fb_rules
from app.domain.detection import MetricInfo
from app.models import (
    ControlCheck,
    ControlTotal,
    Feedback,
    InsightCard,
    Metric,
    MetricSnapshot,
    OnboardingStep,
    RoleMetric,
    Run,
    Tenant,
    ValidationResult,
)
from app.repositories import org as org_repo
from app.repositories import pipeline as repo
from app.services import ai_lab, console, pipeline
from app.services import onboarding as onboarding_service

log = get_logger(__name__)

FEEDBACK_DAYS = console.QUALITY_DAYS
# What the stored answer of an onboarding step holds besides its decisions.
GOLD_IGNORE = stability.PROSE_KEYS | {"locked", "context_benchmark", "link_checks"}
REPLAYABLE = ("discovery", "mapping", "org", "metrics", "rules")


def _dec(value: float | None, places: int = 4) -> Decimal | None:
    return None if value is None else Decimal(str(round(value, places)))


def _f(value: Decimal | float | None) -> float | None:
    return None if value is None else float(value)


# ---------------------------------------------------------------------------------------------
# 1. Control totals
# ---------------------------------------------------------------------------------------------


def _control_view(c: ControlTotal, last: ControlCheck | None, default_tol: float) -> dict[str, Any]:
    tol = _f(c.tolerance_pct) if c.tolerance_pct is not None else default_tol
    out: dict[str, Any] = {
        "key": c.key,
        "name": c.name,
        "metric_key": c.metric_key,
        "entity": c.entity,
        "week": c.week.isoformat() if c.week else None,
        "expected": _f(c.expected),
        "tolerance_pct": tol,
        "source": c.source,
        "active": c.active,
        "last": None,
    }
    if last is not None:
        check = reconcile.Check(
            last.status, float(last.expected), _f(last.ours), None, _f(last.diff_pct)
        )
        out["last"] = {
            "status": last.status,
            "ours": _f(last.ours),
            "diff_pct": _f(last.diff_pct),
            "checked_at": last.created_at.isoformat(),
            "says": reconcile.say(c.name, check, _f(last.tolerance_pct) or default_tol),
        }
    return out


async def _controls(s: Any, tenant_id: uuid.UUID) -> list[tuple[ControlTotal, ControlCheck | None]]:
    controls = (await s.scalars(select(ControlTotal).order_by(ControlTotal.name))).all()
    out = []
    for c in controls:
        last = await s.scalar(
            select(ControlCheck)
            .where(ControlCheck.control_id == c.id)
            .order_by(ControlCheck.created_at.desc())
            .limit(1)
        )
        out.append((c, last))
    return out


async def list_controls(tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
        rows = await _controls(s, tenant_id)
        metrics = (await s.scalars(select(Metric).order_by(Metric.name))).all()
    shown = [_control_view(c, last, rules.control_total_tolerance_pct) for c, last in rows]
    return {
        "controls": shown,
        "default_tolerance_pct": rules.control_total_tolerance_pct,
        "metrics": [{"key": m.key, "name": m.name, "unit": m.unit} for m in metrics],
        "summary": _controls_summary(rows),
    }


def _controls_summary(rows: list[tuple[ControlTotal, ControlCheck | None]]) -> dict[str, Any]:
    checks = [
        reconcile.Check(last.status, float(last.expected), _f(last.ours), None, _f(last.diff_pct))
        for c, last in rows
        if c.active and last is not None
    ]
    return reconcile.summarize(checks)


async def save_control(actor: str, tenant_id: uuid.UUID, body: dict[str, Any]) -> dict[str, Any]:
    key = str(body.get("key") or "").strip().lower().replace(" ", "_")
    if not key or not str(body.get("name") or "").strip():
        raise Invalid("a control total needs a key and a name")
    async with tenant_tx("service", tenant_id) as s:
        if await s.scalar(select(Metric).where(Metric.key == body["metric_key"])) is None:
            raise Invalid(f"this workspace has no metric {body['metric_key']}")
        existing = await s.scalar(select(ControlTotal).where(ControlTotal.key == key))
        week = date.fromisoformat(body["week"]) if body.get("week") else None
        values = {
            "name": str(body["name"]).strip(),
            "metric_key": body["metric_key"],
            "entity": (body.get("entity") or "").strip() or None,
            "week": week,
            "expected": _dec(float(body["expected"])),
            "tolerance_pct": _dec(body.get("tolerance_pct"), 2),
            "source": str(body.get("source") or ""),
            "active": bool(body.get("active", True)),
        }
        if existing is None:
            s.add(ControlTotal(tenant_id=tenant_id, key=key, created_by=actor, **values))
        else:
            for k, v in values.items():
                setattr(existing, k, v)
    await console._log(
        actor, "workspace", f"control_total.{key}", None, str(body["expected"]), tenant_id
    )
    return await list_controls(tenant_id)


async def remove_control(actor: str, tenant_id: uuid.UUID, key: str) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        found = await s.scalar(select(ControlTotal).where(ControlTotal.key == key))
        if found is None:
            raise NotFound("control total")
        await s.delete(found)
    await console._log(actor, "workspace", f"control_total.{key}", "present", None, tenant_id)
    return await list_controls(tenant_id)


async def reconcile_run(tenant_id: uuid.UUID, run_id: uuid.UUID | None = None) -> dict[str, Any]:
    """Compare every active control total with the metric snapshots of a run (the newest run that
    has snapshots, when none is named). One check per control and run: a repeat updates it.

    A flow step: it never raises for a number that does not match, because that is a finding,
    not a failure of the run."""
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
        controls = (await s.scalars(select(ControlTotal).where(ControlTotal.active))).all()
        if not controls:
            return {"status": "skipped", "reason": "no control totals for this workspace"}
        if run_id is None:
            run_id = await s.scalar(
                select(Run.id)
                .where(Run.id.in_(select(MetricSnapshot.run_id)))
                .order_by(Run.started_at.desc())
                .limit(1)
            )
        if run_id is None:
            return {"status": "skipped", "reason": "no run has measured anything yet"}
        metrics = {m.key: m for m in (await s.scalars(select(Metric))).all()}
        found: list[reconcile.Check] = []
        for c in controls:
            metric = metrics.get(c.metric_key)
            snap = await repo.snapshot(s, run_id, metric.id) if metric else None
            ours = reconcile.our_value(snap.series, c.entity, c.week) if snap else None
            tol = _f(c.tolerance_pct) if c.tolerance_pct is not None else None
            tol = rules.control_total_tolerance_pct if tol is None else tol
            check = reconcile.compare(float(c.expected), ours, tol)
            found.append(check)
            row = await s.scalar(
                select(ControlCheck).where(
                    ControlCheck.control_id == c.id, ControlCheck.run_id == run_id
                )
            )
            values = {
                "status": check.status,
                "expected": c.expected,
                "ours": _dec(ours),
                "diff_pct": _dec(check.diff_pct, 3),
                "tolerance_pct": _dec(tol, 2),
            }
            if row is None:
                s.add(ControlCheck(tenant_id=tenant_id, control_id=c.id, run_id=run_id, **values))
            else:
                for k, v in values.items():
                    setattr(row, k, v)
    summary = reconcile.summarize(found)
    if summary["off"] or summary["missing"]:
        log.warning("control_totals.drift", run_id=str(run_id), **summary)
    return {"status": "ok", "run_id": str(run_id), **summary}


# ---------------------------------------------------------------------------------------------
# 2. Backtest
# ---------------------------------------------------------------------------------------------


async def _store(
    actor: str, tenant_id: uuid.UUID, kind: str, subject: str, verdict: str,
    summary: dict[str, Any], detail: dict[str, Any],
) -> dict[str, Any]:  # fmt: skip
    async with tenant_tx("service", tenant_id) as s:
        row = ValidationResult(
            tenant_id=tenant_id, kind=kind, subject=subject, verdict=verdict,
            summary=summary, detail=detail, created_by=actor,
        )  # fmt: skip
        s.add(row)
        await s.flush()
        return _result_view(row)


def _result_view(r: ValidationResult) -> dict[str, Any]:
    return {
        "id": str(r.id),
        "kind": r.kind,
        "subject": r.subject,
        "verdict": r.verdict,
        "summary": r.summary,
        "detail": r.detail,
        "created_by": r.created_by,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


async def backtest_metric(
    actor: str, tenant_id: uuid.UUID, metric_key: str, incidents: list[dict[str, Any]]
) -> dict[str, Any]:
    """Replay detection for one metric over the history its newest snapshot holds."""
    async with tenant_tx("service", tenant_id) as s:
        tenant = await s.get(Tenant, tenant_id)
        rules = await org_repo.rules(s)
        metric = await s.scalar(select(Metric).where(Metric.key == metric_key))
        if tenant is None or metric is None:
            raise NotFound("metric")
        snap = await s.scalar(
            select(MetricSnapshot)
            .where(MetricSnapshot.metric_id == metric.id)
            .order_by(MetricSnapshot.period_end.desc(), MetricSnapshot.created_at.desc())
            .limit(1)
        )
        threshold = await s.scalar(
            select(RoleMetric.threshold).where(RoleMetric.metric_id == metric.id).limit(1)
        )
    if snap is None:
        raise Conflict("this metric has no stored numbers yet: run the metrics first")
    info = MetricInfo(
        key=metric.key, name=metric.name, unit=metric.unit,
        higher_is_better=metric.higher_is_better, unit_value=float(metric.unit_value),
        currency=tenant.currency, threshold=_f(threshold),
    )  # fmt: skip
    series, _drivers, exposure = pipeline.snapshot_inputs(snap)
    known = [
        backtest.Incident(str(i["entity"]), date.fromisoformat(str(i["week"])[:10]),
                          str(i.get("note") or ""))
        for i in incidents
    ]  # fmt: skip
    replayed = backtest.replay(info, series, exposure, rules)
    summary = backtest.summarize(
        replayed, known, noisy_week_pct=rules.backtest_noisy_week_pct,
        lead_weeks=rules.backtest_lead_weeks, min_caught_pct=rules.backtest_min_caught_pct,
    )  # fmt: skip
    summary["entities"] = len(series)
    detail = {"weeks": [r for r in replayed if r["signals"]][-60:]}
    return await _store(
        actor, tenant_id, "backtest", metric_key, summary["verdict"], summary, detail
    )


async def backtest_all(actor: str, tenant_id: uuid.UUID) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        keys = [
            m.key
            for m in (await s.scalars(select(Metric).where(Metric.is_active))).all()
            if await s.scalar(
                select(MetricSnapshot.id).where(MetricSnapshot.metric_id == m.id).limit(1)
            )
            is not None
        ]
    if not keys:
        raise Conflict("no metric has stored numbers yet: run the metrics first")
    return {"results": [await backtest_metric(actor, tenant_id, k, []) for k in keys]}


# ---------------------------------------------------------------------------------------------
# 3 and 4. Stability and regression (these ask the AI and cost money)
# ---------------------------------------------------------------------------------------------


def _spent(*runs: dict[str, Any]) -> dict[str, Any]:
    tokens = sum(r["tokens"]["input"] + r["tokens"]["output"] for r in runs)
    cost = sum(r["cost_usd"] or 0.0 for r in runs)
    return {"tokens": tokens, "cost_usd": round(cost, 4)}


async def stability_test(
    actor: str, tenant_id: uuid.UUID, step: str, version: int | None = None
) -> dict[str, Any]:
    """Ask one onboarding step's agent twice on the input of its latest run and compare."""
    if step not in REPLAYABLE:
        raise NotFound("step")
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
    body = {"version": version} if version else {}
    first = await ai_lab.test(actor, tenant_id, step, body)
    second = await ai_lab.test(actor, tenant_id, step, body)
    if first["output"] is None or second["output"] is None:
        return await _store(
            actor, tenant_id, "stability", step, "failed",
            {"why": "An answer could not be read, so the two runs cannot be compared.",
             "error": first["error"] or second["error"], **_spent(first, second)},
            {},
        )  # fmt: skip
    result = stability.compare(
        [first["output"], second["output"]],
        min_agreement_pct=rules.stability_min_agreement_pct, ignore=GOLD_IGNORE,
    )  # fmt: skip
    summary = {
        "agreement_pct": result["agreement_pct"], "decisions": result["decisions"],
        "agreeing": result["agreeing"], "prompt": first["prompt"], "model": first["model"],
        "required_pct": rules.stability_min_agreement_pct, **_spent(first, second),
    }  # fmt: skip
    detail = {"differences": result["differences"], "more": result["more_differences"]}
    return await _store(actor, tenant_id, "stability", step, result["verdict"], summary, detail)


async def regression_test(
    actor: str, tenant_id: uuid.UUID, step: str, version: int | None = None
) -> dict[str, Any]:
    """Replay a prompt version on the input of the step's newest approved answer; the answer the
    team approved is the gold the new one is scored against."""
    if step not in REPLAYABLE:
        raise NotFound("step")
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
        gold = await s.scalar(
            select(OnboardingStep)
            .where(OnboardingStep.step == step, OnboardingStep.status == "approved")
            .order_by(
                OnboardingStep.approved_at.desc().nulls_last(), OnboardingStep.created_at.desc()
            )
            .limit(1)
        )
    if gold is None or not gold.output:
        raise Conflict(f"no approved {step} answer to replay: approve one first")
    body: dict[str, Any] = {"input": gold.input}
    if version:
        body["version"] = version
    again = await ai_lab.test(actor, tenant_id, step, body)
    if again["output"] is None:
        return await _store(
            actor, tenant_id, "regression", step, "failed",
            {"why": "The replay gave no readable answer.", "error": again["error"],
             **_spent(again)},
            {},
        )  # fmt: skip
    result = stability.regress(
        gold.output, again["output"],
        min_agreement_pct=rules.regression_min_agreement_pct, ignore=GOLD_IGNORE,
    )  # fmt: skip
    summary = {
        "agreement_pct": result["agreement_pct"], "decisions": result["decisions"],
        "reproduced": result["reproduced"], "added": result["added"], "prompt": again["prompt"],
        "approved_prompt": f"v{gold.agent_version}" if gold.agent_version else None,
        "model": again["model"], "required_pct": rules.regression_min_agreement_pct,
        "gold_approved_at": gold.approved_at.isoformat() if gold.approved_at else None,
        **_spent(again),
    }  # fmt: skip
    detail = {"lost": result["lost"], "more": result["more_lost"]}
    return await _store(actor, tenant_id, "regression", step, result["verdict"], summary, detail)


async def card_writer_regression(
    actor: str, tenant_id: uuid.UUID, key: str, version: int, samples: int
) -> dict[str, Any]:
    """The card writer, replayed on real past prompts, must pass the code checks at least as often
    as the version that wrote them (and at the required rate)."""
    from app.services import agents  # a card writer is an agent: the evaluator replays it

    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
    ran = await agents.evaluate(key, version, tenant_id, samples)
    t = ran["totals"]
    old_pct = (
        round(t.get("baseline_valid", 0) / t["baseline_cards"] * 100, 1)
        if t.get("baseline_cards")
        else None
    )
    new_pct = (
        round(t.get("candidate_valid", 0) / t["candidate_cards"] * 100, 1)
        if t.get("candidate_cards")
        else None
    )
    holds = (
        new_pct is not None
        and new_pct >= rules.regression_min_agreement_pct
        and (old_pct is None or new_pct >= old_pct)
    )
    summary = {
        "agreement_pct": new_pct, "baseline_pct": old_pct, "prompt": f"v{version}",
        "cards": t.get("candidate_cards", 0), "readability": t.get("candidate_readability"),
        "baseline_readability": t.get("baseline_readability"), "model": ran["model"],
        "required_pct": rules.regression_min_agreement_pct, "tokens": t.get("tokens", 0),
        "cost_usd": None,
    }  # fmt: skip
    return await _store(
        actor, tenant_id, "regression", key, "holds" if holds else "regressed", summary,
        {"cases": [{"role": c["role"], "error": c["error"]} for c in ran["cases"]]},
    )  # fmt: skip


# ---------------------------------------------------------------------------------------------
# 5. The accuracy picture
# ---------------------------------------------------------------------------------------------


async def results(tenant_id: uuid.UUID, kind: str | None = None, limit: int = 30) -> dict[str, Any]:
    async with tenant_tx("service", tenant_id) as s:
        q = select(ValidationResult).order_by(ValidationResult.created_at.desc()).limit(limit)
        if kind:
            q = q.where(ValidationResult.kind == kind)
        rows = (await s.scalars(q)).all()
    return {"results": [_result_view(r) for r in rows]}


def _latest_per_subject(rows: list[ValidationResult], kind: str) -> list[ValidationResult]:
    seen: dict[str, ValidationResult] = {}
    for r in rows:  # newest first
        if r.kind == kind:
            seen.setdefault(r.subject, r)
    return list(seen.values())


async def accuracy_view(tenant_id: uuid.UUID) -> dict[str, Any]:
    since = datetime.now(UTC) - timedelta(days=FEEDBACK_DAYS)
    async with tenant_tx("service", tenant_id) as s:
        rules = await org_repo.rules(s)
        controls = await _controls(s, tenant_id)
        metrics = (await s.scalars(select(Metric).order_by(Metric.name))).all()
        stored = (
            await s.scalars(select(ValidationResult).order_by(ValidationResult.created_at.desc()))
        ).all()
        cards = (await s.scalars(select(InsightCard).where(InsightCard.created_at >= since))).all()
        notes = (
            await s.scalars(
                select(Feedback.reason).where(
                    Feedback.created_at >= since, Feedback.type == "not_relevant"
                )
            )
        ).all()
    by_status: dict[str, int] = {}
    for c in cards:
        by_status[c.status] = by_status.get(c.status, 0) + 1
    wrong = sum(1 for r in notes if fb_rules.parse_reason(r)[0] == fb_rules.WRONG_NUMBER)
    people = accuracy.feedback_rates(
        cards=len(cards), actioned=by_status.get("actioned", 0),
        not_relevant=by_status.get("not_relevant", 0), impossible=by_status.get("impossible", 0),
        wrong_number=wrong, max_wrong_number_pct=rules.accuracy_max_wrong_number_pct,
        min_feedback=rules.accuracy_min_feedback,
    )  # fmt: skip
    summary = _controls_summary(controls)
    benches = await onboarding_service.benchmark_verdicts(tenant_id)
    backtests = _latest_per_subject(list(stored), "backtest")
    stabilities = _latest_per_subject(list(stored), "stability")
    regressions = _latest_per_subject(list(stored), "regression")
    parts = accuracy.layers(
        reconciliation=summary, benchmarks=benches,
        backtests=[r.verdict for r in backtests], stability=[r.verdict for r in stabilities],
        regression=[r.verdict for r in regressions], people=people,
    )  # fmt: skip
    return {
        "overall": accuracy.overall(parts),
        "layers": parts,
        "people": people,
        "window_days": FEEDBACK_DAYS,
        "controls": [
            _control_view(c, last, rules.control_total_tolerance_pct) for c, last in controls
        ],
        "default_tolerance_pct": rules.control_total_tolerance_pct,
        "metrics": [{"key": m.key, "name": m.name, "unit": m.unit} for m in metrics],
        "benchmarks": benches,
        "tests": {
            "backtest": [_result_view(r) for r in backtests],
            "stability": [_result_view(r) for r in stabilities],
            "regression": [_result_view(r) for r in regressions],
        },
    }
