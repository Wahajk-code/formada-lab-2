"use client";

import { FlaskConical, LoaderCircle, Plus, Rocket, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { draftAgentVersion, evaluateAgent, newAgentVersion, updateAgent } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { AgentDetail, Evaluation } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const field = "w-full rounded-lg border border-input bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/30";

/** Versions, activation, model override, examples switch, new version and evaluation. */
export function AgentEditor({
  agent,
  workspaces,
  can = true,
}: {
  agent: AgentDetail;
  workspaces: { id: string; name: string }[];
  can?: boolean;
}) {
  const router = useRouter();
  const active = agent.versions.find((v) => v.active) ?? agent.versions[0];
  const [selected, setSelected] = useState(active.version);
  const [draft, setDraft] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [ask, setAsk] = useState("");
  const [drafting, startDraft] = useTransition();
  const [draftError, setDraftError] = useState<string | null>(null);
  const [override, setOverride] = useState(agent.model_override ?? "");
  const [workspace, setWorkspace] = useState(workspaces[0]?.id ?? "");
  const [samples, setSamples] = useState(2);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const version = agent.versions.find((v) => v.version === selected) ?? active;

  const run = (fn: () => Promise<{ ok: boolean; error?: string } | void>, done?: string) =>
    start(async () => {
      setMessage(null);
      const res = await fn();
      if (res && !res.ok) return setMessage({ ok: false, text: res.error ?? "Failed" });
      if (done) setMessage({ ok: true, text: done });
      router.refresh();
    });

  return (
    <div className="grid gap-6 xl:grid-cols-[16rem_minmax(0,1fr)]">
      <aside className="space-y-4">
        <section className="space-y-2">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Versions</h2>
          <ul className="space-y-1.5">
            {agent.versions.map((v) => (
              <li key={v.version}>
                <button
                  type="button"
                  onClick={() => { setSelected(v.version); setDraft(null); setEvaluation(null); }}
                  className={cn("w-full rounded-lg px-3 py-2 text-left text-sm transition-all", selected === v.version ? "bg-card shadow-card" : "hover:bg-card/60")}
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="font-medium">v{v.version}</span>
                    {v.active && <span className="rounded-full bg-brand px-1.5 text-[10px] font-semibold uppercase text-brand-foreground">live</span>}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{v.notes || "No notes"}</span>
                  {agent.kind === "card_writer" && (
                    <span className="mt-1 block text-[11px] tabular-nums text-muted-foreground">
                      {v.stats.cards} cards · {pct(v.stats.action_rate)} actioned · {pct(v.stats.rejection_rate)} rejected
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
          <Button size="sm" variant="outline" className="w-full" onClick={() => setDraft(version.body)}>
            <Plus /> New version from v{version.version}
          </Button>
        </section>
        <section className="space-y-2 rounded-xl bg-card p-3 shadow-card">
          <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Settings</h2>
          <label className="block space-y-1 text-xs">
            <span>Model override (provider/model)</span>
            <input className={field} placeholder="workspace choice" value={override} onChange={(e) => setOverride(e.target.value)} />
          </label>
          <Button size="sm" variant="outline" className="w-full" disabled={!can || pending} title={can ? undefined : "Admins only"} onClick={() => run(() => updateAgent(agent.key, { model_override: override }), "Model saved.")}>
            Save model
          </Button>
          {agent.kind === "card_writer" && (
            <label className="flex items-center gap-2 pt-1 text-xs">
              <input
                type="checkbox"
                className="size-4 accent-[var(--brand)]"
                checked={agent.use_examples}
                disabled={!can}
                onChange={(e) => run(() => updateAgent(agent.key, { use_examples: e.target.checked }), "Saved.")}
              />
              Learn from feedback examples
            </label>
          )}
        </section>
      </aside>

      <div className="min-w-0 space-y-4">
        {message && <p className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-surface" : "bg-brand/10 text-brand")}>{message.text}</p>}
        {draft !== null ? (
          <section className="space-y-3 rounded-2xl bg-card p-4 shadow-card">
            <h2 className="text-sm font-semibold">New version of {agent.name}</h2>
            <textarea className={cn(field, "min-h-[28rem] font-mono text-[12px] leading-relaxed")} value={draft} onChange={(e) => setDraft(e.target.value)} />
            <input className={field} placeholder="What changed and why (shown in the version list)" value={notes} onChange={(e) => setNotes(e.target.value)} />
            <div className="flex gap-2">
              <Button size="sm" disabled={pending} onClick={() => run(async () => { const r = await newAgentVersion(agent.key, draft, notes); if (r.ok) { setDraft(null); setNotes(""); } return r; }, "Version saved. It is not live until you activate it.")}>
                Save as new version
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setDraft(null)}>Cancel</Button>
            </div>
          </section>
        ) : (
          <>
          <section className="space-y-2 rounded-2xl bg-card p-4 shadow-card">
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles className="size-4" /> Draft a new version with AI
            </h2>
            <p className="text-xs text-muted-foreground">
              Say what to change. The AI rewrites the live instructions and keeps the rest; the draft opens here for you to read,
              edit and save. Nothing goes live until someone presses Make live.
            </p>
            <form
              className="flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                startDraft(async () => {
                  const r = await draftAgentVersion(agent.key, ask);
                  setDraftError(r.ok ? null : r.error);
                  if (r.ok && r.data) {
                    setDraft(r.data.body);
                    setNotes(`From v${r.data.from_version}: ${r.data.notes}`);
                    setAsk("");
                  }
                });
              }}
            >
              <input
                className={cn(field, "min-w-64 flex-1")}
                value={ask}
                onChange={(e) => setAsk(e.target.value)}
                maxLength={2000}
                placeholder="e.g. keep product names in their original language"
              />
              <Button size="sm" type="submit" disabled={drafting || !ask.trim()}>
                {drafting ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Draft
              </Button>
            </form>
            {draftError && <p className="text-xs text-brand">{draftError}</p>}
          </section>
          <section className="space-y-3 rounded-2xl bg-card p-4 shadow-card">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="flex-1 text-sm font-semibold">
                v{version.version} {version.active ? "(live)" : ""}
                <span className="ml-2 font-normal text-muted-foreground">by {version.created_by.replace("staff:", "")}</span>
              </h2>
              {!version.active && (
                <Button size="sm" disabled={!can || pending} title={can ? undefined : "Admins only"} onClick={() => run(() => updateAgent(agent.key, { active_version: version.version }), `v${version.version} is now live.`)}>
                  <Rocket /> Make live
                </Button>
              )}
            </div>
            <pre className="max-h-[28rem] overflow-auto whitespace-pre-wrap rounded-lg bg-sidebar p-4 font-mono text-[12px] leading-relaxed text-sidebar-foreground">{version.body}</pre>
          </section>
          </>
        )}

        {agent.kind === "card_writer" && draft === null && (
          <section className="space-y-3 rounded-2xl border border-brand/25 bg-brand/5 p-4">
            <h2 className="flex items-center gap-2 text-sm font-semibold"><FlaskConical className="size-4 text-brand" /> Evaluate v{version.version}</h2>
            <p className="text-xs text-muted-foreground">
              Replays this version on the latest real prompts of a workspace and validates the cards exactly as a run would, next to
              what the live version wrote. Nothing is stored. Spends AI tokens (about US$0.001 per sample with Claude Haiku).
            </p>
            <div className="flex flex-wrap items-end gap-2">
              <label className="space-y-1 text-xs">
                <span className="block">Workspace</span>
                <select className={cn(field, "w-56")} value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
                  {workspaces.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
                </select>
              </label>
              <label className="space-y-1 text-xs">
                <span className="block">Samples</span>
                <input type="number" min={1} max={5} className={cn(field, "w-20")} value={samples} onChange={(e) => setSamples(Number(e.target.value))} />
              </label>
              <Button
                size="sm"
                disabled={pending || !workspace}
                onClick={() =>
                  start(async () => {
                    setMessage(null);
                    const res = await evaluateAgent(agent.key, version.version, workspace, samples);
                    if (!res.ok || !res.data) return setMessage({ ok: false, text: res.ok ? "No result" : res.error });
                    setEvaluation(res.data);
                  })
                }
              >
                {pending ? <LoaderCircle className="animate-spin" /> : <FlaskConical />} Run evaluation
              </Button>
            </div>
            {evaluation && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {[
                    ["Live version valid", `${evaluation.totals.baseline_valid ?? 0}/${evaluation.totals.baseline_cards ?? 0}`],
                    [`v${evaluation.version} valid`, `${evaluation.totals.candidate_valid ?? 0}/${evaluation.totals.candidate_cards ?? 0}`],
                    ["Tokens", (evaluation.totals.tokens ?? 0).toLocaleString("en-CA")],
                    ["Model", evaluation.model],
                  ].map(([k, v]) => (
                    <div key={k} className="rounded-lg bg-card px-3 py-2 shadow-card">
                      <p className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{k}</p>
                      <p className="truncate text-sm font-semibold tabular-nums">{v}</p>
                    </div>
                  ))}
                </div>
                {evaluation.cases.map((c, i) => (
                  <div key={i} className="grid gap-3 rounded-xl bg-card p-3 text-xs shadow-card md:grid-cols-2">
                    <p className="font-medium md:col-span-2">{c.role} {c.error && <span className="text-brand">· {c.error}</span>}</p>
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">Live version wrote</p>
                      {c.baseline.map((d, j) => <p key={j} className={cn("py-0.5", d.reasons.length && "text-brand line-through")}>{d.title}</p>)}
                    </div>
                    <div>
                      <p className="mb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">v{evaluation.version} writes</p>
                      {c.candidate.map((d, j) => (
                        <div key={j} className="py-0.5">
                          <p className={cn(d.reasons.length && "text-brand line-through")}>{d.title}</p>
                          {d.reasons.length > 0 ? <p className="text-brand">{d.reasons.join("; ")}</p> : <p className="text-muted-foreground">{d.now_what}</p>}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
