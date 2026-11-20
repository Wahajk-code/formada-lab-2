"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent inputs and answers are schema-checked JSON */

import { Brain } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { LabEditor, LabTester } from "@/components/console/ai-lab/lab-edit";
import { CheckList, FIELD, Peek, secs, usd } from "@/components/console/ai-lab/lab-shared";
import { LabGuide } from "@/components/console/ai-lab/lab-guide";
import { Pill } from "@/components/onboarding/tone";
import type { AgentDetail, LabOverview, LabRun, LabStep, OnboardingGuide } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const n = (v: number) => v.toLocaleString("en-CA");

type Tab = "process" | "prompt" | "criteria" | "test" | "guide";

function Stage({ no, title, tone, children }: { no: number; title: string; tone?: "good" | "bad" | "wait"; children: React.ReactNode }) {
  return (
    <li className="relative pl-12">
      <span
        className={cn(
          "absolute left-0 top-0 grid size-8 place-items-center rounded-full text-xs font-bold",
          tone === "bad" ? "bg-brand text-white" : tone === "wait" ? "bg-surface-strong text-muted-foreground" : "bg-foreground text-background",
        )}
      >
        {no}
      </span>
      <div className="space-y-2 pb-7">
        <h3 className="pt-1.5 text-sm font-semibold">{title}</h3>
        {children}
      </div>
    </li>
  );
}

function ProcessView({ run, step }: { run: LabRun | undefined; step: LabStep }) {
  if (!run) {
    return (
      <p className="rounded-xl bg-surface p-4 text-sm text-muted-foreground">
        This workspace has not run the {step.step} step yet. Run it from its onboarding page and the full process appears here.
      </p>
    );
  }
  const input = run.input ?? {};
  const keys = Object.keys(input);
  const failed = run.status === "failed" || !!run.error;
  return (
    <ol className="relative space-y-0 before:absolute before:left-4 before:top-8 before:bottom-8 before:w-px before:bg-border">
      <Stage no={1} title="Code builds the input">
        <p className="text-xs text-muted-foreground">
          Code reads only the shape of the customer data (names, types, counts, fill rates, dates, tested joins), never rows. The agent
          gets this and nothing else{run.notes ? `, plus the team's notes: “${run.notes}”` : ""}.
        </p>
        <div className="flex flex-wrap gap-1.5">
          {keys.map((k) => (
            <Pill key={k} tone="neutral">{k} · {n(JSON.stringify(input[k]).length)} chars</Pill>
          ))}
        </div>
        <Peek title="The full input" hint={`${n(JSON.stringify(input).length)} characters`} value={input} />
      </Stage>
      <Stage no={2} title="The master prompt">
        <p className="text-xs text-muted-foreground">
          The standing instructions, {run.agent} v{run.agent_version}. They are sent as the system message on every call.
        </p>
        {run.system_prompt ? <Peek title={`${run.agent} v${run.agent_version}`} hint={`${n(run.system_prompt.length)} characters`} value={run.system_prompt} /> : <p className="text-xs text-muted-foreground">That version is no longer stored.</p>}
      </Stage>
      <Stage no={3} title="The model is called">
        <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-5">
          {[
            ["Model", run.model ?? "–"],
            ["Effort", run.effort ?? "–"],
            ["Tokens in / out", `${n(run.tokens.input)} / ${n(run.tokens.output)}`],
            ["Time", secs(run.latency_ms)],
            ["Cost", usd(run.cost_usd)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xl bg-surface p-2.5">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="mt-0.5 font-semibold break-words">{v}</dd>
            </div>
          ))}
        </dl>
      </Stage>
      <Stage no={4} title="What it was thinking">
        {run.thinking ? (
          <div className="flex gap-2 rounded-xl bg-surface p-3 text-xs leading-relaxed">
            <Brain className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
            <p className="max-h-72 overflow-auto whitespace-pre-wrap">{run.thinking}</p>
          </div>
        ) : (
          <p className="rounded-xl bg-surface p-3 text-xs text-muted-foreground">
            No reasoning text came back for this run. The model only writes out its thinking when it chooses to think, which at the medium effort the step runs at it usually does not for this task. Open the Test lab and run it at high effort to see the reasoning.
          </p>
        )}
      </Stage>
      <Stage no={5} title="What it answered" tone={failed ? "bad" : undefined}>
        {run.error && <p className="rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs text-brand">{run.error}</p>}
        {run.output && (
          <>
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(run.output)
                .filter(([, v]) => Array.isArray(v))
                .map(([k, v]) => (
                  <Pill key={k} tone="neutral">{(v as any[]).length} {k.replaceAll("_", " ")}</Pill>
                ))}
            </div>
            <Peek title="The answer, as structured data" value={run.output} />
          </>
        )}
      </Stage>
      <Stage no={6} title="Code checks the answer" tone={run.checks && !(run.checks.errors?.length) ? "good" : "bad"}>
        <CheckList checks={run.checks} />
      </Stage>
      <Stage no={7} title="Our team decides" tone={run.status === "approved" ? "good" : "wait"}>
        <p className="text-xs text-muted-foreground">
          Status: <b className="text-foreground">{run.status}</b>. Nothing reaches the client until a person approves it in the console.
        </p>
      </Stage>
    </ol>
  );
}

/** The five onboarding agents, one step at a time, with the process, prompt, criteria and tests. */
export function Lab({
  workspaces,
  wsId,
  lab,
  step,
  runs,
  agent,
  guide,
  canTest,
  canSave,
  canActivate,
}: {
  workspaces: { id: string; name: string }[];
  wsId: string | null;
  lab: LabOverview;
  step: LabStep;
  runs: LabRun[];
  agent: AgentDetail;
  guide: OnboardingGuide | null;
  canTest: boolean;
  canSave: boolean;
  canActivate: boolean;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("process");
  const [pick, setPick] = useState(0);
  const [draft, setDraft] = useState<{ text: string; from: number | null } | null>(null);
  const run = runs[pick];
  const go = (ws: string | null, st: string) => router.push(`/console/ai-lab?ws=${ws ?? ""}&step=${st}`);
  const tabs = useMemo(
    () =>
      [
        ["process", "Process"],
        ["prompt", "Master prompt"],
        ["criteria", "Criteria"],
        ["test", "Test lab"],
        ...(step.step === "discovery" ? ([["guide", "Data guide"]] as [Tab, string][]) : []),
      ] as [Tab, string][],
    [step.step],
  );

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          Workspace
          <select className={cn(FIELD, "w-72 py-1.5")} value={wsId ?? ""} onChange={(e) => go(e.target.value, step.step)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.name}</option>
            ))}
          </select>
        </label>
        <nav className="flex flex-wrap gap-1.5" aria-label="Onboarding step">
          {lab.steps.map((s) => (
            <button
              key={s.step}
              type="button"
              onClick={() => go(wsId, s.step)}
              className={cn(
                "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
                s.step === step.step ? "bg-foreground text-background" : "bg-surface text-muted-foreground hover:text-foreground",
              )}
            >
              {s.title.split(":")[0].replace(/^(\d)\. /, "$1 · ")}
            </button>
          ))}
        </nav>
      </div>

      <section className="stage-panel stage-content-panel space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{step.title}</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">{step.job}</p>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-xs">
            <Pill tone="neutral">{step.agent_name}</Pill>
            <Pill tone="matched">live v{step.active_version}</Pill>
            <span className="text-muted-foreground">model: {step.model_override ?? "the workspace default"}</span>
          </p>
        </div>

        <div role="tablist" className="flex flex-wrap gap-1 rounded-xl bg-surface p-1">
          {tabs.map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={tab === key}
              type="button"
              onClick={() => setTab(key)}
              className={cn(
                "rounded-lg px-3.5 py-1.5 text-xs font-medium transition-colors",
                tab === key ? "bg-card shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
          {tab === "process" && runs.length > 1 && (
            <select className="ml-auto rounded-lg bg-card px-2 py-1 text-xs" value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Which run">
              {runs.map((r, i) => (
                <option key={r.id} value={i}>
                  {r.created_at.slice(0, 16).replace("T", " ") + " UTC"} · v{r.agent_version} · {r.status}
                </option>
              ))}
            </select>
          )}
        </div>

        {tab === "process" && <ProcessView run={run} step={step} />}
        {tab === "prompt" && (
          <LabEditor
            agent={agent}
            canSave={canSave}
            canActivate={canActivate}
            draft={draft}
            setDraft={setDraft}
            onTest={() => setTab("test")}
          />
        )}
        {tab === "criteria" && (
          <ul className="grid gap-2 sm:grid-cols-2">
            {step.criteria.map((c) => (
              <li key={c.name} className="rounded-xl bg-surface p-3 text-sm">
                <p className="flex items-center gap-2 font-semibold">
                  {c.name} <Pill tone={c.kind === "Code check" ? "matched" : "partial"}>{c.kind}</Pill>
                </p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{c.text}</p>
              </li>
            ))}
            <li className="rounded-xl bg-surface p-3 text-xs text-muted-foreground sm:col-span-2">
              These are fixed in code so an answer can never skip them. The numbers come from this workspace&apos;s business rules; change
              them in Config &amp; rules. The agent&apos;s own judgement is steered by the master prompt, which you can edit here.
              <Peek title="The exact shape of the answer the agent must return" value={step.output_schema} />
            </li>
          </ul>
        )}
        {tab === "test" && (
          <LabTester
            wsId={wsId}
            step={step}
            agent={agent}
            efforts={lab.efforts}
            baseline={runs[0]}
            draft={draft}
            canTest={canTest}
          />
        )}
        {tab === "guide" && <LabGuide run={runs.find((r) => r.output?.tables) ?? runs[0]} guide={guide} wsId={wsId} />}
      </section>
    </div>
  );
}
