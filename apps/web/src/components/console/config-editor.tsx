"use client";

import { ChevronDown, Eye, LoaderCircle, RotateCcw, Save, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  previewChange,
  resetSystemSetting,
  resetWorkspaceSetting,
  setMetric,
  setRoleMetric,
  setSystemSetting,
  setWorkspaceSetting,
  suggestSettings,
} from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { MetricRow, PreviewResult, RoleMetricRow, Setting, SettingsAdvice } from "@/lib/console-api";
import { cn } from "@/lib/utils";

type Props = { can?: boolean } & (
  | { scope: "system"; groups: string[]; settings: Setting[] }
  | {
      scope: "workspace";
      workspaceId: string;
      groups: string[];
      settings: Setting[];
      roleMetrics: RoleMetricRow[];
      metrics: MetricRow[];
    }
);

const GROUP_LABEL: Record<string, string> = {
  detection: "Detection",
  filtering: "Filtering and ranking",
  cards: "Cards",
  feedback: "Feedback loop",
  agents: "AI agents",
  outcomes: "Initiatives and outcomes",
  digest: "Weekly digest",
  runs: "Runs and cost guardrails",
  access: "Access",
};

const inputClass =
  "w-24 rounded-md border border-input bg-card px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-ring/30";

/** Business rules, editable by the internal team only (ADR 0020). Edits stay drafts until saved;
 *  in a workspace, Preview reruns detection on the last weekly run with the drafts applied. */
export function ConfigEditor(props: Props) {
  const router = useRouter();
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [rmDraft, setRmDraft] = useState<Record<string, { weight?: string; threshold?: string; daily_check?: boolean }>>({});
  const [unitDraft, setUnitDraft] = useState<Record<string, string>>({});
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const workspaceId = props.scope === "workspace" ? props.workspaceId : null;
  const can = props.can ?? true;

  const layerValue = (s: Setting) => (props.scope === "system" ? s.system : s.workspace);
  const changed = useMemo(
    () =>
      Object.entries(draft).filter(([key, v]) => {
        const s = props.settings.find((x) => x.key === key);
        return s && v !== "" && Number(v) !== s.effective;
      }),
    [draft, props.settings],
  );
  const rmChanged = Object.entries(rmDraft).filter(([, v]) => Object.keys(v).length > 0);
  const unitChanged = Object.entries(unitDraft).filter(([, v]) => v !== "");
  const dirty = changed.length + rmChanged.length + unitChanged.length;

  function run(fn: () => Promise<void>) {
    setMessage(null);
    start(async () => {
      try {
        await fn();
      } catch (e) {
        setMessage({ ok: false, text: e instanceof Error ? e.message : "Failed" });
      }
    });
  }

  const save = () =>
    run(async () => {
      for (const [key, v] of changed) {
        const res = workspaceId ? await setWorkspaceSetting(workspaceId, key, Number(v)) : await setSystemSetting(key, Number(v));
        if (!res.ok) throw new Error(`${key}: ${res.error}`);
      }
      for (const [id, v] of rmChanged) {
        const body: Record<string, unknown> = {};
        if (v.weight !== undefined) body.weight = Number(v.weight);
        if (v.threshold !== undefined) {
          if (v.threshold === "") body.clear_threshold = true;
          else body.threshold = Number(v.threshold);
        }
        if (v.daily_check !== undefined) body.daily_check = v.daily_check;
        const res = await setRoleMetric(workspaceId!, id, body);
        if (!res.ok) throw new Error(res.error);
      }
      for (const [id, v] of unitChanged) {
        const res = await setMetric(workspaceId!, id, { unit_value: Number(v) });
        if (!res.ok) throw new Error(res.error);
      }
      setDraft({});
      setRmDraft({});
      setUnitDraft({});
      setPreview(null);
      setMessage({ ok: true, text: `Saved ${dirty} change${dirty > 1 ? "s" : ""}. The next run uses them.` });
      router.refresh();
    });

  const runPreview = () =>
    run(async () => {
      const overrides = Object.fromEntries(changed.map(([k, v]) => [k, Number(v)]));
      const rms = Object.fromEntries(
        rmChanged.map(([id, v]) => [
          id,
          {
            ...(v.weight !== undefined ? { weight: Number(v.weight) } : {}),
            ...(v.threshold !== undefined ? { threshold: v.threshold === "" ? null : Number(v.threshold) } : {}),
          },
        ]),
      );
      const res = await previewChange(workspaceId!, overrides, rms);
      if (!res.ok || !res.data) throw new Error(res.ok ? "No preview" : res.error);
      setPreview(res.data);
    });

  const reset = (key: string) =>
    run(async () => {
      const res = workspaceId ? await resetWorkspaceSetting(workspaceId, key) : await resetSystemSetting(key);
      if (!res.ok) throw new Error(res.error);
      setDraft((d) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key)));
      router.refresh();
    });

  const applyAll = (ideas: SettingsAdvice["suggestions"]) =>
    setDraft((d) => ({ ...d, ...Object.fromEntries(ideas.map((i) => [i.key, String(i.value)])) }));

  return (
    <div className="min-w-0 space-y-6">
      <div className="sticky top-14 z-20 flex flex-wrap items-center gap-3 rounded-xl bg-card/95 px-4 py-3 shadow-card backdrop-blur lg:top-2">
        <p className="flex-1 text-sm">
          {dirty ? (
            <span className="font-medium">{dirty} unsaved change{dirty > 1 ? "s" : ""}</span>
          ) : (
            <span className="text-muted-foreground">
              {!can && "View only: developers can edit drafts and preview, admins save. "}
              {props.scope === "system"
                ? "System values apply to every workspace that has no override of its own."
                : "Workspace values override the system value for this client only."}
            </span>
          )}
        </p>
        {workspaceId && (
          <Button size="sm" variant="outline" onClick={runPreview} disabled={pending || !dirty}>
            {pending ? <LoaderCircle className="animate-spin" /> : <Eye />} Preview on last run
          </Button>
        )}
        <Button size="sm" onClick={save} disabled={!can || pending || !dirty} title={can ? undefined : "Admins only"}>
          <Save /> Save
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setDraft({}); setRmDraft({}); setUnitDraft({}); setPreview(null); }} disabled={pending || !dirty}>
          Discard
        </Button>
        {message && <p className={cn("basis-full text-xs", message.ok ? "text-muted-foreground" : "text-destructive")}>{message.text}</p>}
      </div>

      {preview && (
        <section className="animate-rise space-y-3 rounded-2xl border border-brand/30 bg-brand/5 p-4">
          <h3 className="text-sm font-semibold">Preview: cards each role would get on the run of {preview.period_end}</h3>
          <p className="text-xs text-muted-foreground">Detection only, nothing saved and no AI call. Counts are signals that would reach a card (new or already open).</p>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {preview.roles.map((r) => (
              <div key={r.role} className="rounded-xl bg-card p-3 text-sm shadow-card">
                <p className="flex justify-between font-medium">
                  {r.role}
                  <span className="tabular-nums text-muted-foreground">{r.before} → <span className={cn(r.after !== r.before && "font-semibold text-brand")}>{r.after}</span></span>
                </p>
                {r.added.map((s) => (
                  <p key={`a${s.entity}${s.metric}`} className="mt-1 text-xs">+ {s.entity} <span className="text-muted-foreground">({s.kind}, {Math.round(s.impact).toLocaleString("en-CA")} CAD)</span></p>
                ))}
                {r.removed.map((s) => (
                  <p key={`r${s.entity}${s.metric}`} className="mt-1 text-xs text-muted-foreground line-through">− {s.entity} ({s.kind})</p>
                ))}
                {!r.added.length && !r.removed.length && <p className="mt-1 text-xs text-muted-foreground">No change</p>}
              </div>
            ))}
          </div>
        </section>
      )}

      <SettingsAdvisor workspaceId={workspaceId} onApply={applyAll} applied={draft} />

      {props.groups.map((group) => {
        const rows = props.settings.filter((s) => s.group === group);
        if (!rows.length) return null;
        return (
          <section key={group} className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">{GROUP_LABEL[group] ?? group}</h3>
            <div className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-card">
              {rows.map((s) => {
                const own = layerValue(s);
                const value = draft[s.key] ?? String(s.effective);
                const edited = draft[s.key] !== undefined && Number(draft[s.key]) !== s.effective;
                return (
                  <div key={s.key} className={cn("grid items-center gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_auto]", edited && "bg-brand/5")}>
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {s.label}
                        <span className={cn("rounded-full px-1.5 py-px text-[10px] font-semibold uppercase tracking-wider", s.source === "default" ? "bg-surface text-muted-foreground" : "bg-brand text-brand-foreground")}>
                          {s.source}
                        </span>
                      </p>
                      <p className="text-sm text-muted-foreground">{s.simple}</p>
                      <details className="group mt-0.5">
                        <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
                          <ChevronDown className="size-3 transition-transform group-open:rotate-180" /> Details
                        </summary>
                        <p className="mt-1 text-xs text-muted-foreground">{s.help}</p>
                        <p className="mt-0.5 break-all font-mono text-[10px] text-muted-foreground">
                          {s.key} · default {s.default}
                          {props.scope === "workspace" && s.system !== null && ` · system ${s.system}`} · range {s.min}–{s.max}
                        </p>
                      </details>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        className={inputClass}
                        type="number"
                        step={s.integer ? 1 : "any"}
                        min={s.min}
                        max={s.max}
                        value={value}
                        aria-label={s.label}
                        onChange={(e) => setDraft({ ...draft, [s.key]: e.target.value })}
                      />
                      <span className="w-14 text-xs text-muted-foreground">{s.unit}</span>
                      <button
                        type="button"
                        title={own !== null ? "Remove this override" : "No override at this level"}
                        aria-label={`Reset ${s.label}`}
                        disabled={!can || own === null || pending}
                        onClick={() => reset(s.key)}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface hover:text-foreground disabled:opacity-30"
                      >
                        <RotateCcw className="size-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </section>
        );
      })}

      {props.scope === "workspace" && (
        <>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Metrics per role: weight, threshold, daily check</h3>
            <div className="-mx-1 overflow-x-auto">
              <table className="w-full min-w-[40rem] overflow-hidden rounded-xl bg-card text-sm shadow-card">
                <thead>
                  <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                    {["Role", "Metric", "Weight", "Threshold", "Daily check"].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
                  </tr>
                </thead>
                <tbody>
                  {props.roleMetrics.map((rm) => {
                    const d = rmDraft[rm.id] ?? {};
                    const patch = (p: typeof d) => setRmDraft({ ...rmDraft, [rm.id]: { ...d, ...p } });
                    return (
                      <tr key={rm.id} className={cn("border-t border-border/70", Object.keys(d).length > 0 && "bg-brand/5")}>
                        <td className="px-3 py-2">{rm.role}</td>
                        <td className="px-3 py-2">
                          {rm.metric}
                          <p className="text-[11px] text-muted-foreground">{rm.higher_is_better ? "higher is better" : "lower is better"} · {rm.unit}</p>
                        </td>
                        <td className="px-3 py-2">
                          <input className={inputClass} type="number" step="0.1" min={0} max={5} value={d.weight ?? String(rm.weight)} onChange={(e) => patch({ weight: e.target.value })} aria-label={`${rm.role} ${rm.metric} weight`} />
                        </td>
                        <td className="px-3 py-2">
                          <input className={inputClass} type="number" step="any" placeholder="none" value={d.threshold ?? (rm.threshold === null ? "" : String(rm.threshold))} onChange={(e) => patch({ threshold: e.target.value })} aria-label={`${rm.role} ${rm.metric} threshold`} />
                        </td>
                        <td className="px-3 py-2">
                          <input type="checkbox" className="size-4 accent-[var(--brand)]" checked={d.daily_check ?? rm.daily_check} onChange={(e) => patch({ daily_check: e.target.checked })} aria-label={`${rm.role} ${rm.metric} daily check`} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
          <section className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-[0.14em] text-muted-foreground">Metric money value (CAD per unit of change × exposure)</h3>
            <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {props.metrics.map((m) => (
                <label key={m.id} className={cn("flex items-center gap-3 rounded-xl bg-card px-3 py-2 shadow-card", unitDraft[m.id] !== undefined && "ring-1 ring-brand/40")}>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm">{m.name}</span>
                    <span className="block font-mono text-[10px] text-muted-foreground">{m.template}</span>
                  </span>
                  <input className={inputClass} type="number" step="any" min={0} value={unitDraft[m.id] ?? String(m.unit_value)} onChange={(e) => setUnitDraft({ ...unitDraft, [m.id]: e.target.value })} aria-label={`${m.name} unit value`} />
                </label>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** Ask the AI what to change for a goal. Suggestions fill the editor; nothing is saved until
 * someone presses Save, and every value is checked against its range (ADR 0029). */
function SettingsAdvisor({
  workspaceId,
  onApply,
  applied,
}: {
  workspaceId: string | null;
  onApply: (ideas: SettingsAdvice["suggestions"]) => void;
  applied: Record<string, string>;
}) {
  const [goal, setGoal] = useState("");
  const [advice, setAdvice] = useState<SettingsAdvice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const isApplied = (k: string, v: number) => applied[k] !== undefined && Number(applied[k]) === v;
  return (
    <section className="space-y-3 rounded-xl bg-card p-4 shadow-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4" /> Suggest with AI
      </h3>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const res = await suggestSettings(workspaceId, goal);
            setError(res.ok ? null : res.error);
            setAdvice(res.ok ? res.data! : null);
          });
        }}
      >
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          maxLength={2000}
          placeholder={workspaceId ? "What should change? e.g. store managers miss small problems" : "What should change for every workspace?"}
          className="min-w-64 flex-1 rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40"
        />
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Suggest
        </Button>
      </form>
      {error && <p className="text-xs text-brand">{error}</p>}
      {advice && (
        <div className="node-pop space-y-2">
          <p className="text-sm text-muted-foreground">{advice.summary}</p>
          {advice.suggestions.length === 0 ? (
            <p className="text-xs text-muted-foreground">No change suggested: the current values already fit.</p>
          ) : (
            <>
              <ul className="space-y-1.5">
                {advice.suggestions.map((i) => (
                  <li key={i.key} className="flex flex-wrap items-start gap-3 rounded-lg bg-surface px-3 py-2 text-sm">
                    <span className="min-w-0 flex-1">
                      <span className="font-medium">{i.label}</span>: {i.now} → <b>{i.value}</b> {i.unit}
                      <span className="block text-xs text-muted-foreground">{i.why}</span>
                    </span>
                    <Button size="sm" variant="outline" disabled={isApplied(i.key, i.value)} onClick={() => onApply([i])}>
                      {isApplied(i.key, i.value) ? "In the editor" : "Use this"}
                    </Button>
                  </li>
                ))}
              </ul>
              <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <Button size="sm" variant="ghost" onClick={() => onApply(advice.suggestions)}>
                  Use all
                </Button>
                They go into the editor below as unsaved changes. Preview, then Save.
              </p>
            </>
          )}
        </div>
      )}
    </section>
  );
}
