import { notFound, redirect } from "next/navigation";

import { STEP_META, TEAM_STEP_ORDER } from "@/components/console/onboarding/meta";
import { StepView } from "@/components/console/onboarding/step-view";
import { SetupGlance } from "@/components/console/onboarding/setup-glance";
import { TeamStepper } from "@/components/console/onboarding/team-stepper";
import { StepNav } from "@/components/onboarding/stepper";
import type { ThreadStep } from "@/lib/client-api";
import { consoleApi } from "@/lib/console-api";

/** One onboarding step in the Formada view (design + ADR 0030). Rules live inside metrics. */
export default async function OnboardingStepPage({ params }: { params: Promise<{ id: string; step: string }> }) {
  const { id, step } = await params;
  if (step === "rules") redirect(`/console/workspaces/${id}/onboarding/metrics`);
  if (!TEAM_STEP_ORDER.includes(step as ThreadStep)) notFound();
  const key = step as ThreadStep;
  const [state, me, guide] = await Promise.all([
    consoleApi.onboarding(id),
    consoleApi.me(),
    consoleApi.onboardingGuide(id).catch(() => null),
  ]);
  const i = TEAM_STEP_ORDER.indexOf(key);
  const prev = TEAM_STEP_ORDER[i - 1];
  const next = TEAM_STEP_ORDER[i + 1];
  const done = state.progress.steps.find((s) => s.key === key)?.status === "done";
  const href = (s: ThreadStep) => `/console/workspaces/${id}/onboarding/${s}`;
  return (
    <div className="space-y-6">
      <TeamStepper state={state} current={key} workspaceId={id} />
      <SetupGlance state={state} current={key} workspaceId={id} />
      <StepView state={state} stepKey={key} can={me.permissions.includes("config.write")} guide={guide} />
      <StepNav
        prev={prev && { href: href(prev), label: STEP_META[prev].title }}
        next={next && { href: href(next), label: STEP_META[next].title, primary: done }}
        labels={{ prev: "Back", next: "Continue to next step" }}
      />
    </div>
  );
}
