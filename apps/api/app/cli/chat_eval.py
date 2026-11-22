"""Compare prompt versions of the workspace chat on the fixed questions (docs/chat-evals.md).

python -m app.cli.chat_eval <tenant_id> --versions 3 4          # shows the plan and the cost only
python -m app.cli.chat_eval <tenant_id> --versions 3 4 --yes    # asks the AI (costs money)
python -m app.cli.chat_eval <tenant_id> --versions 3 4 --yes --cases vague_it_with_attachment

It reads the workspace and calls the AI. It writes nothing.
"""

import argparse
import asyncio
import json
import uuid
from pathlib import Path

from app.core.logging import configure_logging
from app.domain.llm import estimated_cost
from app.services import chat_eval as svc


async def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument("tenant_id", type=uuid.UUID)
    ap.add_argument(
        "--versions", type=int, nargs="+", required=True, help="prompt versions, old first"
    )
    ap.add_argument("--cases", nargs="*", help="only these case ids")
    ap.add_argument("--yes", action="store_true", help="really ask the AI")
    ap.add_argument("--model", default="claude-sonnet-5-5", help="only used for the cost estimate")
    ap.add_argument("--json", dest="json_out", help="also write every answer to this file")
    args = ap.parse_args()
    configure_logging()

    cases = svc.load_cases()
    if args.cases:
        cases = [c for c in cases if c["id"] in args.cases]
    plan = await svc.plan(args.tenant_id, args.versions, cases)
    guess = estimated_cost(args.model, plan["input_tokens"] + plan["output_tokens"]) or 0.0
    questions, versions = len(plan["runnable"]), len(args.versions)
    print(f"{questions} questions x {versions} versions = {plan['calls']} AI calls")
    print(f"context about {plan['context_tokens']:,} tokens each; roughly US${guess:.2f}")
    print(f"(estimated on {args.model})")
    if plan["skipped"]:
        print(f"skipped (nothing to attach in this workspace): {', '.join(plan['skipped'])}")
    if not args.yes:
        print("dry run: add --yes to ask the AI")
        return
    outcome = await svc.run(args.tenant_id, args.versions, cases)
    print()
    print(svc.report(outcome))
    if args.json_out:
        text = json.dumps(outcome, indent=1, ensure_ascii=False)
        await asyncio.to_thread(Path(args.json_out).write_text, text, encoding="utf-8")
        print(f"\nanswers written to {args.json_out}")


if __name__ == "__main__":
    asyncio.run(main())
