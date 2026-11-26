import Link from "next/link";

import { STATUS_LABEL, STEP_META, TEAM_STEP_ORDER } from "@/components/console/onboarding/meta";
import { Status, type Tone } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { ThreadStep } from "@/lib/client-api";
import type { OnboardingState, TeamStepStatus } from "@/lib/console-api";

/**
 * The whole setup on one line, on every step: how far along it is, and what to do next. The steps
 * themselves are one click away in a fold. It is built only from what the state already holds (each
 * step's status, why the team cannot approve it yet, and its code-computed checks).
 */

const TONE: Record<TeamStepStatus, Tone> = {
  done: "ready",
  review: "decide",
  working: "info",
  failed: "fail",
  client_review: "partial",
  waiting: "partial",
  locked: "missing",
  todo: "missing",
};

/** One plain line for a step: what its checks say, or why it cannot be approved yet. */
function line(state: OnboardingState, key: ThreadStep): string {
  const checks = state.review.checklists[key] ?? [];
  const look = checks.filter((c) => !c.ok);
  const why = state.progress.can_approve[key];
  if (look.length) return `${look.length} of ${checks.length} checks to look at: ${look.slice(0, 2).map((c) => c.title).join("; ")}${look.length > 2 ? "…" : ""}`;
  if (why) return why;
  if (checks.length) return `All ${checks.length} checks pass`;
  return "";
}

function nextAction(state: OnboardingState): { key: ThreadStep; text: string } | null {
  for (const key of TEAM_STEP_ORDER) {
    const s = state.progress.steps.find((x) => x.key === key);
    if (!s || s.status === "done") continue;
    const why = state.progress.can_approve[key];
    const text =
      s.status === "working"
        ? "The AI is working on it."
        : s.status === "failed"
          ? "It failed. Run it again."
          : s.status === "client_review" || s.status === "waiting"
            ? "Waiting on the customer."
            : s.status === "review"
              ? (why ?? "Ready for you to review and approve.")
              : (why ?? STATUS_LABEL[s.status]);
    return { key, text };
  }
  return null;
}

export function SetupGlance({ state, current, workspaceId }: { state: OnboardingState; current: ThreadStep; workspaceId: string }) {
  const steps = TEAM_STEP_ORDER.map((key) => ({ key, s: state.progress.steps.find((x) => x.key === key) }));
  const done = steps.filter((x) => x.s?.status === "done").length;
  const next = nextAction(state);
  const href = (k: ThreadStep) => `/console/workspaces/${workspaceId}/onboarding/${k}`;
  return (
    <details className="sg">
      <summary>
        <span className="sg-count">
          <b>{done === steps.length ? "Setup complete" : `${done} of ${steps.length} steps complete`}</b>
        </span>
        {next ? (
          <span className="sg-next">
            Next: <b>{STEP_META[next.key].name}</b>. {next.text}
          </span>
        ) : (
          <span className="sg-next">Every step is done.</span>
        )}
        <span className="sg-more">
          All steps <Icon name="chevron-down" size={14} />
        </span>
      </summary>
      <ol className="sg-list">
        {steps.map(({ key, s }) => (
          <li key={key} className={key === current ? "is-current" : undefined}>
            <Link href={href(key)}>
              <b>{STEP_META[key].name}</b>
            </Link>
            {s && <Status tone={TONE[s.status]}>{s.questions_for_team ? `${s.questions_for_team} question${s.questions_for_team > 1 ? "s" : ""}` : STATUS_LABEL[s.status]}</Status>}
            <span className="sg-line">{line(state, key)}</span>
          </li>
        ))}
      </ol>
    </details>
  );
}
