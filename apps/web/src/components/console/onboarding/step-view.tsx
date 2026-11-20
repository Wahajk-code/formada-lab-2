"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import {
  Check,
  ChevronDown,
  LoaderCircle,
  Send,
  Sparkles,
  Undo2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  approveConnect,
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
import { AssistantPanel } from "@/components/console/onboarding/assistant-panel";
import { DiscoveryStage } from "@/components/console/onboarding/discovery-stage";
import { RoleTypes, RulesEditor, WhoSeesWhat } from "@/components/console/onboarding/editors";
import { ItemEditor } from "@/components/console/onboarding/item-editor";
import { MappingStage } from "@/components/console/onboarding/mapping-stage";
import { MetricLibrary } from "@/components/console/onboarding/metric-library";
import { RulesPresets } from "@/components/console/onboarding/rules-presets";
import {
  blockingChecks,
  Checklist,
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
import type { OnboardingGuide, OnboardingState, OnboardingStepName } from "@/lib/console-api";
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
              {blockers.map((b) => (
                <li key={b}>
                  <span>
                    <strong>{b}</strong>
                  </span>
                  <span className="stage-badge attention">Blocking</span>
                </li>
              ))}
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
  const [notes, setNotes] = useState(step?.notes || copy?.instructions || "");
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
          {!locked && (ready || (stepKey === "connect" && state.connection)) && (
            <Checklist
              key={`${stepKey}-${step?.id ?? ""}`}
              checks={state.review?.checklists[stepKey] ?? []}
              onDetails={toDetails}
            />
          )}
          {stepKey === "org" && <OrgVerdict state={state} can={can} />}
          {agent && step?.status === "running" && (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircle className="size-4 animate-spin" /> The analysis is
              running. This page updates by itself.
            </p>
          )}
          {agent && step?.status === "failed" && (
            <p className="rounded-lg bg-brand px-3 py-2 text-xs text-brand-foreground">
              {step.error}
            </p>
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
          {agent && !locked && !info.team_approved && (
            <AgentActions
              key={`actions-${step?.id ?? "new"}`}
              name={agent}
              state={state}
              can={can}
              locked={null}
            />
          )}
        </section>

        {ready && stepKey === "metrics" && (
          <WhoSeesWhat
            key={step!.id}
            state={state}
            step={step!}
            editable={editable && step!.status === "proposed"}
          />
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
            />
            <GoLiveBar state={state} can={can} />
          </>
        )}
        {ready && stepKey === "discovery" && (
          <DiscoveryStage out={out} guide={guide} workspaceId={state.workspace.id} stepId={step!.id} can={editable && step!.status === "proposed"} />
        )}
        {ready && stepKey === "mapping" && (
          <MappingStage
            step={step!}
            guide={guide}
            workspaceId={state.workspace.id}
            can={editable && step!.status === "proposed"}
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
        {stepKey !== "discovery" && stepKey !== "mapping" && <AssistantPanel workspaceId={state.workspace.id} step={stepKey} />}
      </aside>
      </div>
    </section>
  );
}
