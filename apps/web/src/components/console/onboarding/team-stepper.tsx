import Link from "next/link";

import { STATUS_LABEL, STEP_META, TEAM_STEP_ORDER } from "@/components/console/onboarding/meta";
import { Icon } from "@/components/ui/icon";
import type { ThreadStep } from "@/lib/client-api";
import type { OnboardingState } from "@/lib/console-api";

/** The six-step bar of the Formada view (design stepper). */
export function TeamStepper({ state, current, workspaceId }: { state: OnboardingState; current: ThreadStep; workspaceId: string }) {
  return (
    <nav className="stepper" aria-label="Onboarding steps">
      <ol>
        {TEAM_STEP_ORDER.map((key) => {
          const s = state.progress.steps.find((x) => x.key === key);
          const done = s?.status === "done";
          const meta = STEP_META[key];
          const label = s?.questions_for_team
            ? `${s.questions_for_team} question${s.questions_for_team > 1 ? "s" : ""}`
            : s
              ? STATUS_LABEL[s.status]
              : "";
          return (
            <li key={key} className={`step-item ${key === current ? "selected" : ""} ${done ? "complete" : ""}`}>
              <Link href={`/console/workspaces/${workspaceId}/onboarding/${key}`} className="step-link" aria-current={key === current ? "step" : undefined}>
                <span className="step-icon">
                  <Icon name={done ? "check" : meta.icon} size={19} />
                </span>
                <span className="step-name">{meta.name}</span>
                <span className="step-status">{label}</span>
              </Link>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
