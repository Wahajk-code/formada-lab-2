"use client";

import { Loader2, Play, Rocket, Save, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { activateLabVersion, runLabTest, saveLabPrompt } from "@/app/console-actions";
import { CheckList, FIELD, Peek, secs, usd } from "@/components/console/ai-lab/lab-shared";
import { Pill } from "@/components/onboarding/tone";
import { Button } from "@/components/ui/button";
import type { AgentDetail, LabRun, LabStep, LabTestBody, LabTestResult } from "@/lib/console-api";
import { cn } from "@/lib/utils";

type Draft = { text: string; from: number | null } | null;

/** Read, edit, save and switch on the master prompt of one agent. */
export function LabEditor({
  agent,
  canSave,
  canActivate,
  draft,
  setDraft,
  onTest,
}: {
  agent: AgentDetail;
  canSave: boolean;
  canActivate: boolean;
  draft: Draft;
  setDraft: (d: Draft) => void;
  onTest: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [shown, setShown] = useState<number>(agent.active_version);
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const current = agent.versions.find((v) => v.version === shown);
  const text = draft?.text ?? current?.body ?? "";
  const changed = draft !== null && draft.text !== (agent.versions.find((v) => v.version === draft.from)?.body ?? "");

  const pickVersion = (v: number) => {
    setShown(v);
    setDraft(null);
    setMsg(null);
  };
  const say = (res: { ok: boolean; error?: string }, ok: string) => {
    setMsg(res.ok ? ok : (res.error ?? "Something went wrong."));
    if (res.ok) router.refresh();
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        {agent.versions.map((v) => (
          <button
            key={v.version}
            type="button"
            onClick={() => pickVersion(v.version)}
            className={cn(
              "rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              shown === v.version && !changed ? "bg-foreground text-background" : "bg-surface text-muted-foreground hover:text-foreground",
            )}
            title={v.notes}
          >
            v{v.version}
            {v.active ? " · live" : ""}
          </button>
        ))}
        {changed && <Pill tone="partial">Edited draft (not saved)</Pill>}
      </div>
      {current?.notes && !changed && <p className="text-xs text-muted-foreground">{current.notes}</p>}
      <textarea
        className={cn(FIELD, "min-h-[28rem] font-mono text-[12px] leading-relaxed")}
        spellCheck={false}
        value={text}
        readOnly={!canSave}
        onChange={(e) => setDraft({ text: e.target.value, from: draft?.from ?? shown })}
        aria-label="Master prompt"
      />
      <p className="text-xs text-muted-foreground">{text.length.toLocaleString("en-CA")} characters. This text is the system message the agent gets on every call.</p>
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={cn(FIELD, "w-72")}
          placeholder="What did you change, and why?"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          aria-label="Notes for the new version"
        />
        <Button
          size="sm"
          disabled={!canSave || pending || !changed || notes.trim().length < 3}
          onClick={() => start(async () => say(await saveLabPrompt(agent.key, text, notes), "Saved as a new version. It is not live yet."))}
        >
          <Save className="size-3.5" aria-hidden /> Save as a new version
        </Button>
        <Button size="sm" variant="outline" onClick={onTest} disabled={!text}>
          <Play className="size-3.5" aria-hidden /> Test this text
        </Button>
        {canActivate && !changed && current && !current.active && (
          <Button
            size="sm"
            variant="outline"
            disabled={pending}
            onClick={() => start(async () => say(await activateLabVersion(agent.key, current.version), `v${current.version} is now live for every new run.`))}
          >
            <Rocket className="size-3.5" aria-hidden /> Make v{current.version} live
          </Button>
        )}
      </div>
      {msg && <p className="text-xs text-muted-foreground" role="status">{msg}</p>}
    </div>
  );
}

type Result = LabTestResult & { id: number; label: string };

const shapeText = (s: Record<string, number>) =>
  Object.entries(s)
    .map(([k, v]) => `${v} ${k.replaceAll("_", " ")}`)
    .join(" · ") || "–";

/** Try a prompt, notes, model, effort or input on the case of the latest run, side by side. */
export function LabTester({
  wsId,
  step,
  agent,
  efforts,
  baseline,
  draft,
  canTest,
}: {
  wsId: string | null;
  step: LabStep;
  agent: AgentDetail;
  efforts: string[];
  baseline: LabRun | undefined;
  draft: Draft;
  canTest: boolean;
}) {
  const [source, setSource] = useState<string>(draft ? "draft" : String(agent.active_version));
  const [notes, setNotes] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("high");
  const [editInput, setEditInput] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(0);
  const variants = agent.versions.filter((v) => /^variant/i.test(v.notes));

  const body = (src: string): LabTestBody => {
    const b: LabTestBody = { notes: notes || undefined, model: model || undefined, effort };
    if (src === "draft") b.prompt = draft?.text;
    else b.version = Number(src);
    if (editInput !== null) b.input = JSON.parse(editInput);
    return b;
  };
  const exec = async (src: string, label: string) => {
    setBusy((n) => n + 1);
    try {
      const res = await runLabTest(wsId!, step.step, body(src));
      if (res.ok && res.data) setResults((r) => [{ ...res.data!, id: Date.now() + Math.random(), label }, ...r]);
      else if (!res.ok) setErr(res.error);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "The test failed.");
    } finally {
      setBusy((n) => n - 1);
    }
  };
  const labelOf = (src: string) => (src === "draft" ? "Your draft" : `v${src}`);
  const run = (src: string) => {
    setErr(null);
    void exec(src, labelOf(src));
  };
  const runVariants = () => {
    setErr(null);
    variants.forEach((v) => void exec(String(v.version), `v${v.version} · ${v.notes.split(":")[0]}`));
  };

  if (!baseline) return <p className="rounded-xl bg-surface p-4 text-sm text-muted-foreground">Run this step once on the workspace first; the lab replays that input.</p>;

  return (
    <div className="space-y-4">
      <div className="grid gap-3 md:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Prompt to test
          <select className={FIELD} value={source} onChange={(e) => setSource(e.target.value)}>
            {draft && <option value="draft">Your edited draft (from the Master prompt tab)</option>}
            {agent.versions.map((v) => (
              <option key={v.version} value={v.version}>
                v{v.version}{v.active ? " (live)" : ""} {v.notes ? `· ${v.notes.slice(0, 50)}` : ""}
              </option>
            ))}
          </select>
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs text-muted-foreground">
            Model (provider/model)
            <input className={FIELD} placeholder={baseline.model ?? "the agent's own"} value={model} onChange={(e) => setModel(e.target.value)} />
          </label>
          <label className="space-y-1 text-xs text-muted-foreground">
            Thinking effort (high shows reasoning)
            <select className={FIELD} value={effort} onChange={(e) => setEffort(e.target.value)}>
              {efforts.map((x) => (
                <option key={x}>{x}</option>
              ))}
            </select>
          </label>
        </div>
        <label className="space-y-1 text-xs text-muted-foreground md:col-span-2">
          Extra notes for this test only (added to the team notes the agent reads)
          <textarea className={cn(FIELD, "min-h-16")} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="For example: treat the semantic view as the source for sales." />
        </label>
      </div>

      <div className="space-y-2">
        <button type="button" className="text-xs font-medium underline-offset-2 hover:underline" onClick={() => setEditInput(editInput === null ? JSON.stringify(baseline.input, null, 2) : null)}>
          {editInput === null ? "Edit the input the agent receives" : "Use the original input again"}
        </button>
        {editInput !== null && (
          <>
            <textarea className={cn(FIELD, "min-h-64 font-mono text-[11px]")} spellCheck={false} value={editInput} onChange={(e) => setEditInput(e.target.value)} aria-label="Agent input as JSON" />
            <p className="text-xs text-muted-foreground">It must stay valid JSON. Code checks the answer against the profile inside this input.</p>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!canTest || !wsId || busy > 0} onClick={() => run(source)}>
          {busy > 0 ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Play className="size-3.5" aria-hidden />} Run this test
        </Button>
        {variants.length > 0 && (
          <Button size="sm" variant="outline" disabled={!canTest || !wsId || busy > 0} onClick={runVariants}>
            <Sparkles className="size-3.5" aria-hidden /> Run the {variants.length} variants side by side
          </Button>
        )}
        {busy > 0 && <span className="text-xs text-muted-foreground">{busy} running. A real model call takes one to several minutes and uses tokens.</span>}
        {!canTest && <span className="text-xs text-muted-foreground">Your role cannot run tests.</span>}
      </div>
      {err && <p className="rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs text-brand" role="alert">{err}</p>}

      {results.length > 0 && (
        <div className="overflow-x-auto rounded-xl bg-surface">
          <table className="w-full text-left text-xs">
            <thead className="text-muted-foreground">
              <tr>
                {["Prompt", "Guide score", "Model", "Tokens in / out", "Time", "Cost", "Checks", "What it produced"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-border/50 text-muted-foreground">
                <td className="px-3 py-2">Last saved run</td>
                <td className="px-3 py-2">–</td>
                <td className="px-3 py-2">{baseline.model}</td>
                <td className="px-3 py-2">{baseline.tokens.input.toLocaleString("en-CA")} / {baseline.tokens.output.toLocaleString("en-CA")}</td>
                <td className="px-3 py-2">{secs(baseline.latency_ms)}</td>
                <td className="px-3 py-2">{usd(baseline.cost_usd)}</td>
                <td className="px-3 py-2">{baseline.checks ? `${baseline.checks.errors?.length ?? 0} errors · ${baseline.checks.warnings?.length ?? 0} warnings` : "–"}</td>
                <td className="px-3 py-2">{shapeText(results[0].baseline_shape)}</td>
              </tr>
              {results.map((r) => (
                <tr key={r.id} className="border-t border-border/50">
                  <td className="px-3 py-2 font-semibold">{r.label}</td>
                  <td className="px-3 py-2 font-semibold">{r.audit ? `${r.audit.score}/100` : "–"}</td>
                  <td className="px-3 py-2">{r.model}</td>
                  <td className="px-3 py-2">{r.tokens.input.toLocaleString("en-CA")} / {r.tokens.output.toLocaleString("en-CA")}</td>
                  <td className="px-3 py-2">{secs(r.latency_ms)}</td>
                  <td className="px-3 py-2">{usd(r.cost_usd)}</td>
                  <td className="px-3 py-2">{r.error ? <span className="text-brand">{r.error}</span> : `${r.checks?.errors?.length ?? 0} errors · ${r.checks?.warnings?.length ?? 0} warnings`}</td>
                  <td className="px-3 py-2">{shapeText(r.shape)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {results.map((r) => (
        <article key={r.id} className="space-y-2 rounded-2xl bg-card p-4 shadow-sm">
          <h4 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
            {r.label} <Pill tone="neutral">{r.model}</Pill> <Pill tone="neutral">effort {r.effort}</Pill>
          </h4>
          {r.error && <p className="rounded-lg bg-brand/10 px-2.5 py-1.5 text-xs text-brand">{r.error}</p>}
          {r.audit && (
            <ul className="grid gap-1 text-xs sm:grid-cols-2">
              {r.audit.items.map((i) => (
                <li key={i.name} className="flex justify-between gap-3 rounded-lg bg-surface px-2.5 py-1.5">
                  <span>{i.name} <span className="text-muted-foreground">· {i.note}</span></span>
                  <b>{i.points}/{i.max}</b>
                </li>
              ))}
            </ul>
          )}
          <CheckList checks={r.checks} />
          {r.thinking && <Peek title="What it was thinking" value={r.thinking} />}
          {r.output && <Peek title="Its answer" value={r.output} />}
          {r.raw && <Peek title="Raw text (the answer did not parse)" value={r.raw} />}
        </article>
      ))}
    </div>
  );
}
