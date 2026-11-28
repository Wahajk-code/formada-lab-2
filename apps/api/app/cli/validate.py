# ruff: noqa: E501  (the usage lines in the help text are examples to copy)
"""Run the accuracy checks of one workspace from the terminal (docs/how-we-validate.md).

python -m app.cli.validate <tenant_id> accuracy                  # the whole picture, nothing is run
python -m app.cli.validate <tenant_id> reconcile                 # control totals against the newest run
python -m app.cli.validate <tenant_id> backtest [--metric KEY] [--incidents incidents.json]
python -m app.cli.validate <tenant_id> stability  --step mapping --yes     # asks the AI twice (costs)
python -m app.cli.validate <tenant_id> regression --step mapping --yes     # asks the AI once (costs)
python -m app.cli.validate <tenant_id> regression --step mapping --version 11 --yes

incidents.json is a list of {"entity": "...", "week": "2026-09-14", "note": "stock-out"}.
The two AI checks do nothing without --yes. Results are stored and shown on the console's
Accuracy page.
"""

import argparse
import asyncio
import json
import uuid
from pathlib import Path
from typing import Any

from app.core.logging import configure_logging
from app.services import validation

ACTOR = "cli"


def show(title: str, result: dict[str, Any]) -> None:
    print(f"\n{title}")
    print(json.dumps(result, indent=1, ensure_ascii=False, default=str))


async def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tenant_id", type=uuid.UUID)
    ap.add_argument(
        "what", choices=["accuracy", "reconcile", "backtest", "stability", "regression"]
    )
    ap.add_argument("--step", choices=["discovery", "mapping", "org", "metrics", "rules"])
    ap.add_argument("--version", type=int, help="prompt version to test (default: the active one)")
    ap.add_argument("--metric", help="backtest only this metric")
    ap.add_argument("--incidents", help="a JSON file of real past incidents, for the backtest")
    ap.add_argument("--yes", action="store_true", help="really ask the AI (costs money)")
    args = ap.parse_args()
    configure_logging()

    if args.what == "accuracy":
        view = await validation.accuracy_view(args.tenant_id)
        print(f"{view['overall']['status'].upper()}: {view['overall']['text']}\n")
        for layer in view["layers"]:
            print(f"  [{layer['status']:>5}] {layer['label']}: {layer['detail']}")
        return
    if args.what == "reconcile":
        show("Control totals", await validation.reconcile_run(args.tenant_id))
        return
    if args.what == "backtest":
        incidents: list[dict[str, Any]] = []
        if args.incidents:
            text = await asyncio.to_thread(Path(args.incidents).read_text, encoding="utf-8")
            incidents = json.loads(text)
        if args.metric:
            done = await validation.backtest_metric(ACTOR, args.tenant_id, args.metric, incidents)
            show(f"Backtest of {args.metric}", done)
        else:
            for r in (await validation.backtest_all(ACTOR, args.tenant_id))["results"]:
                print(f"{r['subject']:<40} {r['verdict']:<10} {r['summary']['why']}")
        return
    if not args.step:
        ap.error(f"{args.what} needs --step")
    calls = 2 if args.what == "stability" else 1
    print(f"{args.what} of {args.step}: {calls} AI call(s) on the saved input, which costs money.")
    if not args.yes:
        print("dry run: add --yes to ask the AI")
        return
    run = validation.stability_test if args.what == "stability" else validation.regression_test
    show(f"{args.what} of {args.step}", await run(ACTOR, args.tenant_id, args.step, args.version))


if __name__ == "__main__":
    asyncio.run(main())
