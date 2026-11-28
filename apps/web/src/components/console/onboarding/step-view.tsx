"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import {
  Check,
  ChevronDown,
  LoaderCircle,
  Send,
  Sparkles,
  TriangleAlert,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  approveConnect,
  cancelOnboardingStep,
  approveOnboardingStep,
  approveTrial,
  askClient,
  goLive,
  proposeOnboardingStep,
  reopenStep,
  replyToClient,
  resolveTeamThread,
  returnOrgDraft,
} from "@/app/console-actions";
import {
  Badge,
  Checks,
  ConnectStep,
  Meta,
  MetricsView,
  OrgView,
} from "@/components/console/onboarding/views";
import { DiscoveryStage } from "@/components/console/onboarding/discovery-stage";
import { RoleTypes, RulesEditor, WhoSeesWhat } from "@/components/console/onboarding/editors";
import { ItemEditor } from "@/components/console/onboarding/item-editor";
import { MappingStage } from "@/components/console/onboarding/mapping-stage";
import { MetricLibrary } from "@/components/console/onboarding/metric-library";
import { RulesPresets } from "@/components/console/onboarding/rules-presets";
import { ConnectReach } from "@/components/console/onboarding/connect-reach";
import { ContextBenchmark, type Benchmark } from "@/components/console/onboarding/context-benchmark";
import { RoleCoverage } from "@/components/console/onboarding/role-coverage";
import { StepChat } from "@/components/console/onboarding/step-chat";
import {
  blockingChecks,
  Checklist,
  HAS_CHECKLIST,
} from "@/components/console/onboarding/review";
import { TrialPanel } from "@/components/console/onboarding/trial-panel";
import { RunButton } from "@/components/console/run-button";
import { OrgBuilder } from "@/components/onboarding/org-builder";
import { Questions, TEAM_LABELS } from "@/components/onboarding/questions";
import { CheckinEditor } from "@/components/console/onboarding/checkin-editor";
import { STEP_META } from "@/components/console/onboarding/meta";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import type { ThreadStep } from "@/lib/client-api";
import type { OnboardingGuide, OnboardingState, OnboardingStep, OnboardingStepName } from "@/lib/console-api";
import { clearWorkspaceChats } from "@/lib/chat-store";
import { cn } from "@/lib/utils";

const FIELD =
  "w-full rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";
const AGENT_STEPS: OnboardingStepName[] = [
  "discovery",
  "mapping",
  "org",
  "metrics",
  "rules",
];

// ---------------------------------------------------------------------------------------------
// Verdicts: the few things the team needs to decide, in plain words
// ---------------------------------------------------------------------------------------------

function OrgVerdict({ state, can }: { state: OnboardingState; can: boolean }) {
  const router = useRouter();
  const d = state.draft;
  const step = state.steps.org;
  const out = step?.output as any;
  const [returning, setReturning] = useState(false);
  const [note, setNote] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const kept = out?.roles?.length ?? 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge tone={d.status === "draft" ? "warn" : "ok"}>
          {d.status === "draft"
            ? d.nodes.length
              ? "Client is still drawing"
              : "No chart yet"
            : d.status === "submitted"
              ? "Client sent their chart"
              : "Chart approved"}
        </Badge>
        {d.nodes.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {d.nodes.length} roles · from {d.source} · by{" "}
            {d.updated_by || "client"}
          </span>
        )}
        {d.status === "submitted" && can && !returning && (
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            onClick={() => setReturning(true)}
          >
            <Undo2 /> Send back with a note
          </Button>
        )}
      </div>
      {returning && (
        <div className="node-pop space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What should the client change?"
            className={FIELD}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending || !note.trim()}
              onClick={() =>
                start(async () => {
                  const res = await returnOrgDraft(state.workspace.id, note);
                  setError(res.ok ? null : res.error);
                  if (res.ok) setReturning(false);
                  router.refresh();
                })
              }
            >
              <Send /> Send back
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReturning(false)}
            >
              Cancel
            </Button>
            {error && <span className="text-xs text-brand">{error}</span>}
          </div>
        </div>
      )}
      {out && !out.raw && (
        <p className="text-sm">
          <span className="font-medium">AI proposal:</span> {kept} roles on the
          org web
          {step?.checks?.from_client_draft &&
            d.nodes.length > kept &&
            `, ${d.nodes.length - kept} left out (no data for them yet)`}
          .
        </p>
      )}
      {d.status === "draft" && !step && (
        <p className="text-xs text-muted-foreground">
          Wait for the client&apos;s chart, ask them about it on the right, or
          describe the org in the notes and let the AI draft it.
        </p>
      )}
    </div>
  );
}

function TrialRunPanel({ state, canRun }: { state: OnboardingState; canRun: boolean }) {
  const t = state.trial;
  return (
    <section className="stage-panel stage-content-panel stage-ai-panel">
      <div className="stage-panel-heading">
        <span className="stage-heading-icon">
          <Icon name="play" size={19} />
        </span>
        <div>
          <h3>Validate the setup</h3>
          <p>Run the roles and measures on the customer&apos;s real data and check what each role would see.</p>
        </div>
        <span className="stage-badge accent">Trial run</span>
      </div>
      <div className="stage-form stage-trial-form">
        <div className="flex flex-wrap items-center gap-3">
          <RunButton workspaceId={state.workspace.id} can={canRun} />
          {t && (
            <span className="stage-helper">
              Last run {t.status} · {t.cards} card{t.cards === 1 ? "" : "s"} ·{" "}
              {new Date(t.at).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: state.workspace.timezone })}
            </span>
          )}
          <Link href={`/console/workspaces/${state.workspace.id}?tab=runs`} className="stage-inline-link">
            Runs and cards
          </Link>
        </div>
      </div>
    </section>
  );
}

function GoLiveBar({ state, can }: { state: OnboardingState; can: boolean }) {
  const router = useRouter();
  const [invite, setInvite] = useState(true);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const live = state.lifecycle === "live";
  const blockers = state.progress.blockers;
  const named = state.draft.nodes.filter((n) => n.email && !n.vacant).length;
  return (
    <section className="stage-panel stage-content-panel">
      <div className="stage-panel-heading">
        <span className="stage-heading-icon">
          <Icon name="rocket" size={19} />
        </span>
        <div>
          <h3>{live ? `Live since ${new Date(state.live_at!).toLocaleDateString("en-CA", { timeZone: state.workspace.timezone })}` : "Go live"}</h3>
          <p>
            {live
              ? "The customer's full app is unlocked."
              : "The customer reviews the trial and goes live from their workspace. You can also do it for them."}
          </p>
        </div>
      </div>
      {!live && (
        <>
          {blockers.length > 0 && (
            <ul className="stage-role-coverage">
              {blockers.map((b) => {
                const step = /^(\w+): not complete yet$/.exec(b)?.[1] as ThreadStep | undefined;
                const meta = step ? STEP_META[step] : undefined;
                return (
                  <li key={b}>
                    <span>
                      <strong>{meta ? `${meta.name} is not complete yet` : b === "run a successful trial first" ? "The trial has not run successfully yet" : b}</strong>
                    </span>
                    {meta ? (
                      <Link className="stage-inline-link" href={`/console/workspaces/${state.workspace.id}/onboarding/${step}`}>
                        Open {meta.name} <Icon name="arrow-right" size={14} />
                      </Link>
                    ) : (
                      <span className="stage-badge attention">Blocking</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="stage-complete">
            <div>
              {named > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={invite} onChange={(e) => setInvite(e.target.checked)} />
                  Invite the {named} people named in their chart
                </label>
              ) : (
                <span>Going live unlocks the client&apos;s full app and emails them.</span>
              )}
              {msg && <span className="stage-helper">{msg}</span>}
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={!can || pending || blockers.length > 0}
              onClick={() =>
                start(async () => {
                  const res = await goLive(state.workspace.id, invite);
                  if (res.ok) clearWorkspaceChats(state.workspace.id); // onboarding is done
                  setMsg(res.ok ? `Live. ${res.data?.invited.length ?? 0} invite(s) sent.` : res.error);
                  router.refresh();
                })
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Icon name="rocket" size={17} />}
              <span>Go live</span>
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Where the summary ends and the full evidence starts (both always shown, in that order). */
function DetailsHeading() {
  return (
    <div id="step-details" className="flex scroll-mt-6 items-center gap-3 pt-2">
      <span className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
        Details
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Approving past an open warning needs a reason (ADR 0029)
// ---------------------------------------------------------------------------------------------

function OverrideReason({
  count,
  value,
  onChange,
}: {
  count: number;
  value: string;
  onChange: (v: string) => void;
}) {
  if (!count) return null;
  return (
    <label className="block w-full space-y-1 text-xs">
      <span className="font-medium text-[var(--attention-ink)]">
        {count} check{count === 1 ? "" : "s"} still need attention. Why approve anyway? (kept in the audit log)
      </span>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        maxLength={500}
        placeholder="e.g. Client confirmed by phone; fixing in the next run"
        className={FIELD}
      />
    </label>
  );
}

// ---------------------------------------------------------------------------------------------
// Sign-off: the team approves, then the client; only the team can reopen (edit and update)
// ---------------------------------------------------------------------------------------------

/** Times in the workspace's timezone, so the server and the browser render the same text. */
function when(at: string | null, timeZone: string) {
  return at
    ? new Date(at).toLocaleString("en-CA", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone,
      })
    : "";
}

function SignoffPanel({
  state,
  stepKey,
  can,
}: {
  state: OnboardingState;
  stepKey: ThreadStep;
  can: boolean;
}) {
  const router = useRouter();
  const sign = state.signoffs[stepKey];
  const info = state.progress.steps.find((s) => s.key === stepKey)!;
  const reason = state.progress.can_approve[stepKey];
  const [reopening, setReopening] = useState(false);
  const [note, setNote] = useState("");
  const [why, setWhy] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const live = state.lifecycle === "live";
  const blocking = blockingChecks(state, stepKey).length;

  const run = (fn: () => Promise<{ ok: boolean; error?: string }>) =>
    start(async () => {
      const res = await fn();
      setMsg(res.ok ? null : (res.error ?? "Failed"));
      if (res.ok) setReopening(false);
      router.refresh();
    });


  return (
    <section className="animate-rise space-y-3 rounded-2xl bg-card p-5 shadow-card">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold">Completion</h3>
        {sign && sign.reopened > 0 && (
          <span className="text-[11px] text-muted-foreground">
            reopened {sign.reopened}x
            {sign.reopen_note ? `: ${sign.reopen_note}` : ""}
          </span>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {info.status === "done"
          ? `Complete${sign?.team_by ? ` · ${sign.team_by.replace("staff:", "")}` : ""}${sign?.team_at ? ` · ${when(sign.team_at, state.workspace.timezone)}` : ""}`
          : stepKey === "trial"
            ? state.trial && ["succeeded", "partial"].includes(state.trial.status)
              ? "The customer can now review the trial run and go live from their workspace."
              : "Run the trial once metrics are published. The customer goes live after a successful run."
            : stepKey === "org"
              ? "The customer builds and confirms their Org Web; you then apply it here."
              : "Completing this step updates both views."}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {stepKey === "connect" && !info.team_approved && !reason && (
          <OverrideReason count={blocking} value={why} onChange={setWhy} />
        )}
        {stepKey === "connect" && !info.team_approved && (
          <Button
            disabled={!can || pending || !!reason || (blocking > 0 && !why.trim())}
            title={reason ?? undefined}
            onClick={() =>
              run(() =>
                stepKey === "connect"
                  ? approveConnect(state.workspace.id, why)
                  : approveTrial(state.workspace.id, why),
              )
            }
          >
            <Check /> Mark connection complete
          </Button>
        )}
        {stepKey === "connect" && !info.team_approved && reason && (
          <span className="text-xs text-muted-foreground">{reason}</span>
        )}

        {info.team_approved && !live && !reopening && (
          <Button
            variant="outline"
            size="sm"
            disabled={!can || pending}
            onClick={() => setReopening(true)}
          >
            <Undo2 /> Reopen to edit
          </Button>
        )}
        {msg && <span className="text-xs text-brand">{msg}</span>}
      </div>
      {reopening && (
        <div className="node-pop space-y-2">
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={2}
            placeholder="What will change? The client sees this note. Later steps keep their approval."
            className={FIELD}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={pending}
              onClick={() =>
                run(() => reopenStep(state.workspace.id, stepKey, note))
              }
            >
              <Undo2 /> Reopen
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setReopening(false)}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Agent action bar
// ---------------------------------------------------------------------------------------------

/** The AI card on each step (design): what the AI does, editable instructions, and its buttons. */
const STAGE_COPY: Partial<
  Record<
    OnboardingStepName,
    { icon: string; title: string; body: string; instructions: string; start: string; again: string; note?: string }
  >
> = {
  discovery: {
    icon: "sparkles",
    title: "Discover source data",
    body: "Scan approved schemas and describe what each table contains.",
    instructions:
      "Discover the Sales and Purchasing tables. Identify their keys, columns and the business questions they can answer.",
    start: "Start AI discovery",
    again: "Run discovery again",
    note: "A new run starts fresh and ignores locks. Use the chat to change only some cards.",
  },
  mapping: {
    icon: "sparkles",
    title: "Map source fields",
    body: "Match customer fields to Formada's standard model. Review the proposed target, rationale, and confidence.",
    instructions:
      "Map Sales and Purchasing fields to the Formada standard model. Flag uncertain matches for review.",
    start: "Generate AI mappings",
    again: "Regenerate mappings",
  },
  metrics: {
    icon: "sparkles",
    title: "Generate a metric catalog",
    body: "Use confirmed mappings and the Org Web to generate metrics and automatically match them to roles.",
    instructions:
      "Build actionable weekly metrics for Sales and Purchasing from the confirmed mappings. Give each metric a calculation, unit and threshold.",
    start: "Generate metrics",
    again: "Regenerate",
    note: "Matching metrics keep their settings and role assignments.",
  },
};

/** The note a step carries is what the team asked for, or the record of an edit ("x revised by AI: ...",
 * "y confirmed"). Only the first belongs in the instructions box. */
const EDIT_NOTE = /(revised by AI|edited by hand|edited by our team|changes by AI| confirmed$| unlocked$|(link|relationship) (added|removed):)/;
const ownNotes = (note: string | null | undefined) => (note && !EDIT_NOTE.test(note) ? note : "");

function AgentActions({
  name,
  state,
  can,
  locked,
}: {
  name: OnboardingStepName;
  state: OnboardingState;
  can: boolean;
  locked: string | null;
}) {
  const router = useRouter();
  const step = state.steps[name];
  const copy = STAGE_COPY[name];
  const [showNotes, setShowNotes] = useState(
    Boolean(copy) || (name === "org" && !state.draft.nodes.length && !step),
  );
  const [notes, setNotes] = useState(ownNotes(step?.notes) || copy?.instructions || "");
  const [why, setWhy] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const running = step?.status === "running";
  const id = state.workspace.id;
  const blocking = step?.status === "proposed" ? blockingChecks(state, name).length : 0;
  // Approving a mapping keeps the links that pass their live test and skips the failing ones.
  const mappingChecks = (name === "mapping" ? step?.checks?.archetypes : null) ?? {};
  const failingMappings = name === "mapping"
    ? ((step?.output as any)?.archetypes ?? []).filter(
        (a: any) => a.status !== "unmappable" && !mappingChecks[a.archetype]?.ok,
      ).length
    : 0;

  if (locked)
    return (
      <p className="rounded-xl bg-surface px-4 py-3 text-sm text-muted-foreground">
        {locked}
      </p>
    );

  const body = (
    <div className="space-y-2">
      {showNotes && !copy && (
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder={
            name === "org"
              ? "Describe the client's structure if they have not sent a chart."
              : "Anything the AI should know (client answers, exclusions, priorities)."
          }
          className={cn(FIELD, "node-pop")}
        />
      )}
      <OverrideReason count={blocking} value={why} onChange={setWhy} />
      <div className="flex flex-wrap items-center gap-2">
        {step?.status === "proposed" && (
          <Button
            disabled={!can || pending || !!state.progress.can_approve[name] || (blocking > 0 && !why.trim())}
            title={state.progress.can_approve[name] ?? undefined}
            onClick={() =>
              start(async () => {
                const res = await approveOnboardingStep(id, step.id, undefined, why);
                setMsg(res.ok ? "Approved." : res.error);
                router.refresh();
              })
            }
          >
            <Check /> {name === "metrics" ? "Publish metrics" : name === "rules" ? "Apply rules" : `Mark ${name === "org" ? "Org Web" : name} complete`}
            {failingMappings > 0 && ` (skips ${failingMappings} failing)`}
          </Button>
        )}
        <Button
          variant={step?.status === "proposed" ? "outline" : "default"}
          disabled={!can || pending || running}
          onClick={() =>
            start(async () => {
              const res = await proposeOnboardingStep(id, name, notes === copy?.instructions ? "" : notes);
              setMsg(res.ok ? null : res.error);
              router.refresh();
            })
          }
        >
          {running ? <LoaderCircle className="animate-spin" /> : <Sparkles />}
          {running ? "Analysing…" : step ? (copy?.again ?? "Run the analysis again") : (copy?.start ?? "Start analysis")}
        </Button>
        {copy?.note && step && <span className="text-xs text-muted-foreground">{copy.note}</span>}
        {!showNotes && (
          <Button variant="ghost" size="sm" onClick={() => setShowNotes(true)}>
            Add notes
          </Button>
        )}
        {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
      </div>
    </div>
  );
  if (!copy) return body;
  return (
    <section className="stage-panel stage-content-panel">
      <div className="stage-panel-heading">
        <span className="stage-heading-icon">
          <Icon name={copy.icon} size={19} />
        </span>
        <div>
          <h3>{copy.title}</h3>
          <p>{copy.body}</p>
        </div>
      </div>
      <div className="stage-form">
        <label>
          Instructions
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} disabled={!can || running} />
        </label>
        {body}
      </div>
    </section>
  );
}

/** What the team sees while an AI step runs or after it fails: plain words, a way to stop it, and
 * the technical details tucked away. A step never shows an endless spinner. */
function StepStatus({ step, workspaceId, can, stepName }: { step: OnboardingStep; workspaceId: string; can: boolean; stepName: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [now, setNow] = useState(() => Date.now());
  const running = step.status === "running";
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const stop = () =>
    start(async () => {
      await cancelOnboardingStep(workspaceId, stepName);
      router.refresh();
    });

  if (running) {
    const secs = Math.max(0, Math.round((now - new Date(step.created_at).getTime()) / 1000));
    const slow = secs > 180;
    return (
      <div className={cn("step-status", slow && "slow")} role="status" aria-live="polite">
        <LoaderCircle className="size-4 animate-spin" />
        <div>
          <strong>{slow ? "This is taking longer than usual" : "The AI is working"}</strong>
          <p>
            {Math.floor(secs / 60)}:{String(secs % 60).padStart(2, "0")} elapsed.{" "}
            {slow ? "You can stop it and run it again." : "This page updates by itself. Most steps take one to three minutes."}
          </p>
        </div>
        {can && (
          <button type="button" className="btn btn-secondary" disabled={pending} onClick={stop}>
            Stop this step
          </button>
        )}
      </div>
    );
  }

  const [reason, details] = (step.error ?? "The step failed.").split(" (Details: ");
  return (
    <div className="step-status failed" role="alert">
      <TriangleAlert className="size-4" />
      <div>
        <strong>This step did not finish</strong>
        <p>{reason}</p>
        {details && (
          <details>
            <summary>Technical details</summary>
            <code>{details.replace(/\)$/, "")}</code>
          </details>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// One step
// ---------------------------------------------------------------------------------------------

export function StepView({
  state,
  stepKey,
  can,
  guide,
}: {
  state: OnboardingState;
  stepKey: ThreadStep;
  can: boolean;
  guide: OnboardingGuide | null;
}) {
  const router = useRouter();
  const meta = STEP_META[stepKey];
  const info = state.progress.steps.find((s) => s.key === stepKey)!;
  const anyRunning = state.progress.steps.some((s) => s.status === "working");
  const [details, setDetails] = useState(false);
  const toDetails = () =>
    document.getElementById("step-details")?.scrollIntoView({ behavior: "smooth", block: "start" });

  useEffect(() => {
    if (!anyRunning) return;
    const t = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(t);
  }, [anyRunning, router]);

  const agent = AGENT_STEPS.includes(stepKey as OnboardingStepName)
    ? (stepKey as OnboardingStepName)
    : null;
  const step = agent ? state.steps[agent] : undefined;
  const out = step?.output as any;
  const ready =
    step &&
    step.status !== "running" &&
    step.status !== "failed" &&
    out &&
    !out.raw;
  // Sequential: a step opens once every earlier step is approved by both sides (ADR 0027).
  const locked =
    info.status === "locked"
      ? "Opens once the earlier steps are complete."
      : null;
  const editable =
    can && !locked && !info.team_approved && state.lifecycle !== "live";
  const threads = state.threads.filter((t) => t.step === stepKey);
  // Discovery and Mapping are read first: their actions (instructions, mark complete, run again) come
  // after the review and before the chat, not above the summary.
  const actionsAfter = Boolean(ready) && (stepKey === "discovery" || stepKey === "mapping");
  const afterReview =
    actionsAfter && agent && !locked && !info.team_approved ? (
      <section className="stage-panel stage-content-panel space-y-4">
        <AgentActions key={`actions-${step?.id ?? "new"}`} name={agent} state={state} can={can} locked={null} />
      </section>
    ) : null;

  return (
    <section className="step-content" aria-labelledby="step-heading">
      <header className="step-heading">
        <div>
          <h2 id="step-heading">{meta.title}</h2>
          <p>{meta.what}</p>
        </div>
        <div className="step-side">
          <span className="step-owner">
            <Icon name="user" size={16} />
            {meta.owner} owns this step
          </span>
        </div>
      </header>
      <div className={cn("onboarding-grid", stepKey === "org" && "builder-layout")}>
      <div className="min-w-0 space-y-4">

        <section className="stage-panel stage-content-panel space-y-4">
          {locked && (
            <p className="rounded-xl bg-surface px-4 py-3 text-sm text-muted-foreground">
              {locked}
            </p>
          )}
          {!locked && HAS_CHECKLIST(stepKey) && (ready || (stepKey === "connect" && state.connection)) && (
            <Checklist
              key={`${stepKey}-${step?.id ?? ""}`}
              checks={state.review?.checklists[stepKey] ?? []}
              onDetails={toDetails}
            />
          )}
          {stepKey === "org" && <OrgVerdict state={state} can={can} />}
          {stepKey === "org" && <RoleCoverage state={state} guide={guide} />}
          {(stepKey === "org" || stepKey === "metrics" || stepKey === "rules") && (
            <ContextBenchmark subject={stepKey} benchmark={(step?.output as { context_benchmark?: Benchmark | null } | null | undefined)?.context_benchmark} />
          )}
          {stepKey === "connect" && state.connection?.status === "ok" && <ConnectReach guide={guide} tested={state.connection?.test_result?.views} />}
          {agent && step && (step.status === "running" || step.status === "failed") && (
            <StepStatus step={step} workspaceId={state.workspace.id} can={can} stepName={stepKey} />
          )}
          {ready && <DetailsHeading />}
          {ready && step!.status === "proposed" && editable && stepKey !== "mapping" && (
            <ItemEditor workspaceId={state.workspace.id} stepKey={stepKey} step={step!} can={can} />
          )}
          {ready && stepKey === "rules" && (
            <RulesEditor
              key={step!.id}
              state={state}
              step={step!}
              guide={guide}
              editable={editable && step!.status === "proposed"}
            />
          )}
          {ready && step!.checks && stepKey !== "mapping" && (
            <Checks checks={step!.checks} />
          )}
          {agent && !step && !locked && stepKey !== "org" && (
            <p className="text-sm text-muted-foreground">Not started. Start the analysis below.</p>
          )}
          {agent && !locked && !info.team_approved && stepKey !== "metrics" && !actionsAfter && (
            <AgentActions
              key={`actions-${step?.id ?? "new"}`}
              name={agent}
              state={state}
              can={can}
              locked={null}
            />
          )}
        </section>

        {stepKey === "metrics" && !locked && (
          <section className="stage-panel stage-content-panel">
            <div className="stage-panel-heading">
              <span className="stage-heading-icon">
                <Icon name="message-circle" size={19} />
              </span>
              <div>
                <h3>Customer suggestions</h3>
                <p>Review what the customer would like their roles to track.</p>
              </div>
            </div>
            {(() => {
              const ideas = threads
                .filter((t) => t.raised_by === "client" || t.messages.some((m) => m.side === "client"))
                .map((t) => ({ id: t.id, text: t.messages.find((m) => m.side === "client")?.body ?? t.title, at: t.updated_at }));
              return ideas.length ? (
                <ul className="customer-ideas">
                  {ideas.map((i) => (
                    <li key={i.id}>
                      <span>{i.text}</span>
                      <time>{new Date(i.at).toLocaleDateString("en-CA", { day: "numeric", month: "short" })}</time>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="stage-helper">No suggestions from the customer yet.</p>
              );
            })()}
          </section>
        )}
        {ready && stepKey === "metrics" && (
          <WhoSeesWhat
            key={step!.id}
            state={state}
            step={step!}
            editable={editable && step!.status === "proposed"}
            guide={guide}
          />
        )}
        {agent && stepKey === "metrics" && !locked && !info.team_approved && (
          <details className="ai-instructions" open>
            <summary>
              <Icon name="sparkles" size={16} />
              <span>AI generation instructions</span>
              <Icon name="chevron-down" size={16} />
            </summary>
            <AgentActions
              key={`actions-${step?.id ?? "new"}`}
              name={agent}
              state={state}
              can={can}
              locked={null}
            />
          </details>
        )}
        {ready && stepKey === "metrics" && (
          <MetricLibrary key={`lib-${step!.id}`} state={state} step={step!} editable={editable && step!.status === "proposed"} />
        )}
        {stepKey === "org" && !locked && <OrgBuilder draft={state.draft} editable={false} />}
        {stepKey === "connect" && !locked && <ConnectStep state={state} can={editable} />}
        {stepKey === "trial" && !locked && (
          <>
            <TrialRunPanel state={state} canRun={editable} />
            <TrialPanel
              workspaceId={state.workspace.id}
              runId={state.trial?.run_id ?? null}
              running={state.trial?.status === "running"}
              roleCount={state.draft.nodes.length}
              can={editable}
              currency={state.workspace.currency}
            />
            <GoLiveBar state={state} can={can} />
          </>
        )}
        {ready && stepKey === "discovery" && (
          <DiscoveryStage out={out} guide={guide} workspaceId={state.workspace.id} stepId={step!.id} can={editable && step!.status === "proposed"} actions={afterReview} />
        )}
        {ready && stepKey === "mapping" && (
          <MappingStage
            step={step!}
            guide={guide}
            workspaceId={state.workspace.id}
            can={editable && step!.status === "proposed"}
            actions={afterReview}
          />
        )}

        {stepKey === "metrics" && !locked && (
          <section className="stage-panel stage-content-panel space-y-4">
            <div className="stage-panel-heading">
              <span className="stage-heading-icon">
                <Icon name="shield" size={19} />
              </span>
              <div>
                <h3>Business rules</h3>
                <p>How much each role hears. Set them before publishing metrics.</p>
              </div>
            </div>
            <RulesPresets
              workspaceId={state.workspace.id}
              overrides={state.rules}
              currency={state.workspace.currency}
              can={editable}
            />
            {state.steps.rules && state.steps.rules.status !== "running" && state.steps.rules.output && !(state.steps.rules.output as any).raw && (
              <RulesEditor
                key={state.steps.rules.id}
                state={state}
                step={state.steps.rules}
                guide={guide}
                editable={editable && state.steps.rules.status === "proposed"}
              />
            )}
            {editable && <AgentActions key={state.steps.rules?.id ?? "rules-new"} name="rules" state={state} can={can} locked={null} />}
          </section>
        )}

        {stepKey === "org" && !locked && (
          <RoleTypes
            guide={guide}
            used={new Set(state.org.roles.map((r) => r.archetype ?? ""))}
          />
        )}

        {!locked && stepKey === "org" && (
          <StepChat
            workspaceId={state.workspace.id}
            stepName="org"
            step={state.steps.org}
            can={editable && state.steps.org?.status === "proposed"}
            starters={["Which roles will not get cards, and why?", "Explain this org web in plain words", "Simplify: who owns what?"]}
          />
        )}
        {!locked && stepKey === "connect" && state.connection?.status === "ok" && (
          <StepChat
            workspaceId={state.workspace.id}
            stepName="connect"
            can={false}
            starters={["What can this connection read for sales?", "Is anything missing for stock or purchasing?", "Which views are not linked to each other?"]}
          />
        )}
        {!locked && stepKey === "trial" && (
          <StepChat
            workspaceId={state.workspace.id}
            stepName="trial"
            can={false}
            runId={state.trial?.run_id ?? null}
            starters={["Which roles produced no cards, and why?", "Explain the weakest card", "Simplify the trial result"]}
          />
        )}
        {!locked && stepKey === "metrics" && (
          <StepChat
            workspaceId={state.workspace.id}
            stepName="metrics"
            step={state.steps.metrics}
            can={editable && state.steps.metrics?.status === "proposed"}
            starters={["Which three measures matter most for the Buyer?", "Why is each measure on the plan?", "Simplify the metric plan"]}
          />
        )}
        {!locked && <SignoffPanel state={state} stepKey={stepKey} can={can} />}

        {ready && (
          <section className="rounded-2xl bg-card shadow-card">
            <button
              type="button"
              onClick={() => setDetails(!details)}
              className="flex w-full items-center gap-2 px-5 py-3 text-left text-sm font-medium"
            >
              <ChevronDown
                className={cn(
                  "size-4 transition-transform duration-200",
                  details && "rotate-180",
                )}
              />
              Technical details
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {step!.model} · US${(step!.cost_usd ?? 0).toFixed(3)}
              </span>
            </button>
            {details && (
              <div className="node-pop space-y-4 border-t border-border/60 p-5">
                <Meta step={step!} />
                {stepKey === "org" && <OrgView out={out} />}
                {stepKey === "metrics" && <MetricsView step={step!} />}
                {stepKey === "rules" && <Checks checks={step!.checks} />}
              </div>
            )}
          </section>
        )}
      </div>

      <aside className="onboard-rail" aria-label="Setup support">
        <Questions
          threads={threads}
          side="team"
          labels={TEAM_LABELS}
          can={can}
          onAsk={(title, body) =>
            askClient(state.workspace.id, stepKey, title, body)
          }
          onReply={(threadId, body) =>
            replyToClient(state.workspace.id, threadId, body)
          }
          onResolve={(threadId) =>
            resolveTeamThread(state.workspace.id, threadId)
          }
        />
        <CheckinEditor
          workspaceId={state.workspace.id}
          checkin={state.checkin}
          can={can}
          timezone={state.workspace.timezone}
        />
      </aside>
      </div>
    </section>
  );
}
