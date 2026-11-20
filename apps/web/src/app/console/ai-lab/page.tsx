import { FlaskConical } from "lucide-react";

import { Lab } from "@/components/console/ai-lab/lab";
import { type AgentDetail, consoleApi, type LabRuns } from "@/lib/console-api";

/** Dev mode for the onboarding agents: what each one is given, how it is told to think, what it
 * answered and what code made of it. Prompts, notes, model and input can be edited and tried on
 * the same case. Internal team only. */
export default async function AiLabPage({ searchParams }: { searchParams: Promise<{ ws?: string; step?: string }> }) {
  const [{ ws, step: stepParam }, overview, me] = await Promise.all([searchParams, consoleApi.overview(), consoleApi.me()]);
  const workspaces = [...overview.workspaces].sort((a, b) => a.name.localeCompare(b.name));
  const wsId = ws ?? workspaces.find((w) => /live snowflake/i.test(w.name))?.id ?? workspaces[0]?.id;
  const lab = await consoleApi.aiLab(wsId);
  const step = lab.steps.find((s) => s.step === stepParam) ?? lab.steps[0];
  const empty: LabRuns = { step: step.step, runs: [] };
  const [runs, agent, guide] = await Promise.all([
    wsId ? consoleApi.aiLabRuns(wsId, step.step).catch(() => empty) : empty,
    consoleApi.agent(step.agent) as Promise<AgentDetail>,
    wsId && step.step === "discovery" ? consoleApi.onboardingGuide(wsId).catch(() => null) : null,
  ]);
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console · dev mode</p>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <FlaskConical className="size-6" aria-hidden /> AI lab
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Follow each onboarding agent from the input code gave it, through its master prompt and reasoning, to its answer and the
          checks code ran. Edit the prompt, add notes, change the model or the input, and try it on the same case. Nothing here
          changes a workspace until you save a version and switch it on.
        </p>
      </header>
      <Lab
        key={`${wsId}-${step.step}`}
        workspaces={workspaces.map((w) => ({ id: w.id, name: w.name }))}
        wsId={wsId ?? null}
        lab={lab}
        step={step}
        runs={runs.runs}
        agent={agent}
        guide={guide}
        canTest={me.permissions.includes("agent.evaluate")}
        canSave={me.permissions.includes("agent.draft")}
        canActivate={me.permissions.includes("agent.activate")}
      />
    </div>
  );
}
