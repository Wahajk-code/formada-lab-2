"""Trial scorecard: is this run good enough to show a customer?

Pure checks over a run's detail (steps, signals, cards, rejections, calls) as the console builds
it. Nothing here asks a model: every line is counted from what the run stored. The human pass in
the client dashboard comes after this, and the scorecard tells the reviewer where to look first.
"""

import re
from typing import Any

PASS, WARN, FAIL = "pass", "warn", "fail"
_WORD = re.compile(r"[^a-z0-9]+")


def _check(key: str, status: str, title: str, detail: str, fix: str = "") -> dict[str, str]:
    return {"key": key, "status": status, "title": title, "detail": detail, "fix": fix}


def _norm(title: str) -> str:
    return _WORD.sub(" ", (title or "").lower()).strip()[:60]


def _money(value: float) -> str:
    return f"{value:,.0f}"


def score_run(detail: dict[str, Any]) -> dict[str, Any]:
    run = detail.get("run") or {}
    signals = detail.get("signals") or []
    cards = detail.get("cards") or []
    rejections = detail.get("rejections") or []
    calls = detail.get("calls") or []
    steps = detail.get("steps") or []
    checks: list[dict[str, str]] = []

    # 1. The run itself
    if run.get("status") == "failed":
        checks.append(
            _check("finished", FAIL, "The run finished", run.get("error") or "It failed.")
        )
    elif not run.get("ended_at"):
        checks.append(_check("finished", WARN, "The run finished", "It is still running.", "Wait."))
    else:
        checks.append(_check("finished", PASS, "The run finished", f"Status {run.get('status')}."))

    # 2. Every role that had something to say got a card
    live = {s["role"] for s in signals if s["status"] in ("selected", "carded")}
    carded_roles = {c["role"] for c in cards}
    silent = sorted(live - carded_roles)
    if silent:
        checks.append(
            _check(
                "roles",
                WARN,
                "Every role with signals has a card",
                f"No card for {', '.join(silent)}.",
                "Open the run: the writer may have proposed none, or the cap was reached.",
            )
        )
    else:
        checks.append(
            _check(
                "roles",
                PASS,
                "Every role with signals has a card",
                f"{len(carded_roles)} role(s) have cards.",
            )
        )

    # 3. The validator
    proposed = len(cards) + len(rejections)
    if rejections:
        rate = round(100 * len(rejections) / proposed)
        status = WARN if rate <= 25 else FAIL
        checks.append(
            _check(
                "validator",
                status,
                "The writer's drafts pass the validator",
                f"{len(rejections)} of {proposed} drafts rejected ({rate}%).",
                "Read the rejection reasons in the run: they show what the prompt gets wrong.",
            )
        )
    else:
        checks.append(
            _check(
                "validator",
                PASS,
                "The writer's drafts pass the validator",
                f"All {proposed} drafts accepted.",
            )
        )

    # 4. Big signals that never became cards
    carded = [s for s in signals if s["status"] == "carded"]
    dropped = [s for s in signals if s["status"] == "dropped"]
    floor = min((s["impact"] or 0 for s in carded), default=0)
    missed = sorted((s for s in dropped if (s["impact"] or 0) >= floor), key=lambda s: -s["impact"])
    if missed and carded:
        top = ", ".join(f"{s['entity']} ({s['role']}, {_money(s['impact'])})" for s in missed[:3])
        checks.append(
            _check(
                "dropped",
                WARN,
                "No big signal was left out",
                f"{len(missed)} left out below the top N: {top}.",
                "Raise the per-role limit, or check how the ranking weighs this metric.",
            )
        )
    else:
        checks.append(
            _check(
                "dropped",
                PASS,
                "No big signal was left out",
                f"{len(dropped)} dropped, none above the smallest card.",
            )
        )

    # 5. Near-duplicate cards for one role
    seen: dict[tuple[str, str], int] = {}
    for c in cards:
        k = (c["role"], _norm(c["title"]))
        seen[k] = seen.get(k, 0) + 1
    dupes = [f"{r}: {t}" for (r, t), n in seen.items() if n > 1]
    if dupes:
        checks.append(
            _check(
                "duplicates",
                WARN,
                "No near-duplicate cards",
                "; ".join(dupes[:3]),
                "Ask the writer for one card per entity.",
            )
        )
    else:
        checks.append(
            _check("duplicates", PASS, "No near-duplicate cards", f"{len(cards)} distinct.")
        )

    # 6. The customer's data under the mappings, and the metrics themselves
    metrics = next((s for s in steps if s["step"] == "metrics_run"), None)
    mdetail = (metrics or {}).get("detail") or {}
    health = mdetail.get("mapping_health")
    if health is None:
        checks.append(
            _check(
                "mapping_health",
                PASS,
                "The mappings still match the data",
                "Not measured on this kind of run.",
            )
        )
    elif health["status"] == "ok":
        checks.append(
            _check(
                "mapping_health",
                PASS,
                "The mappings still match the data",
                "Rows, fields and keys are as approved.",
            )
        )
    else:
        issues = [i for a in health.get("archetypes", []) for i in a.get("issues", [])]
        status = FAIL if health["status"] == "fail" else WARN
        checks.append(
            _check(
                "mapping_health",
                status,
                "The mappings still match the data",
                "; ".join(issues[:3]) or str(health.get("error", "")),
                "Compare with the approved mapping first.",
            )
        )
    bad_metrics = (mdetail.get("failed") or []) + [
        {"metric": m} for m in mdetail.get("truncated") or []
    ]
    if bad_metrics:
        names = ", ".join(str(m.get("metric")) for m in bad_metrics[:4])
        checks.append(
            _check(
                "metrics",
                WARN,
                "Every metric ran in full",
                f"Cut short: {names}.",
                "Check the template, or raise the row cap.",
            )
        )
    else:
        checks.append(
            _check(
                "metrics",
                PASS,
                "Every metric ran in full",
                f"{mdetail.get('snapshots', 0)} metric(s) computed.",
            )
        )

    # 7. The AI calls
    failed_calls = [c for c in calls if c.get("status") != "ok"]
    if failed_calls:
        checks.append(
            _check(
                "calls",
                WARN,
                "Every AI call succeeded",
                f"{len(failed_calls)} of {len(calls)} calls did not.",
                "Open the run to read the errors.",
            )
        )
    else:
        checks.append(_check("calls", PASS, "Every AI call succeeded", f"{len(calls)} calls."))

    verdict = (
        FAIL
        if any(c["status"] == FAIL for c in checks)
        else (WARN if any(c["status"] == WARN for c in checks) else PASS)
    )
    return {
        "verdict": verdict,
        "checks": checks,
        "numbers": {
            "cards": len(cards),
            "signals": len(signals),
            "dropped": len(dropped),
            "rejections": len(rejections),
            "tokens": run.get("llm_tokens"),
        },
    }
