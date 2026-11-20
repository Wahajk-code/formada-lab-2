"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { BookOpen, ChevronDown, LoaderCircle, Plus, Save, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { draftCustomMetric, editMetricsProposal, editRulesProposal } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Pill, TONE } from "@/components/onboarding/tone";
import type { OnboardingGuide, OnboardingState, OnboardingStep } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const FIELD = "rounded-lg bg-surface px-2 py-1.5 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";
const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-CA", { maximumFractionDigits: 4 }) : "–");

// ---------------------------------------------------------------------------------------------
// Org: what each role type means
// ---------------------------------------------------------------------------------------------

export function RoleTypes({ guide, used }: { guide: OnboardingGuide | null; used: Set<string> }) {
  const [open, setOpen] = useState(false);
  const types = guide?.role_archetypes ?? [];
  const byBook = types.reduce<Record<string, typeof types>>((acc, t) => {
    (acc[t.playbook ?? "general"] ??= []).push(t);
    return acc;
  }, {});
  return (
    <section className="rounded-2xl bg-card shadow-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-2 px-5 py-3 text-left text-sm font-medium">
        <BookOpen className="size-4" /> Role types guide
        <span className="text-xs font-normal text-muted-foreground">what each role type decides, must not decide, and is judged on</span>
        <ChevronDown className={cn("ml-auto size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="node-pop space-y-5 border-t border-border/60 p-5">
          <p className="text-sm text-muted-foreground">
            Every role on the org web starts from a role type. The type decides which measures the role can own and what its cards may tell it to do. A card never asks
            a role to make a decision its type forbids. Types used here are marked.
          </p>
          {Object.entries(byBook).map(([book, list]) => (
            <div key={book} className="space-y-2">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{book} playbook</h4>
              <div className="grid gap-2 md:grid-cols-2">
                {list.map((t) => (
                  <div key={t.key} className={cn("space-y-2 rounded-xl p-3 text-xs", used.has(t.key) ? TONE.matched : "bg-surface")}>
                    <p className="text-sm font-semibold">
                      {t.title ?? t.key} <span className="font-mono text-[10px] font-normal opacity-70">{t.key}</span>
                      {used.has(t.key) && <span className="ml-2 rounded-full bg-[var(--iris)] px-1.5 text-[10px] text-white">used</span>}
                    </p>
                    <div>
                      <p className="font-semibold text-[var(--positive-ink)]">Decides</p>
                      <ul className="list-disc pl-4">{t.decisions_owned.slice(0, 5).map((d) => <li key={d}>{d}</li>)}</ul>
                    </div>
                    {t.decisions_forbidden.length > 0 && (
                      <div>
                        <p className="font-semibold text-[var(--critical-ink)]">Never asked to</p>
                        <ul className="list-disc pl-4">{t.decisions_forbidden.slice(0, 4).map((d) => <li key={d}>{d}</li>)}</ul>
                      </div>
                    )}
                    {t.kpi_notes && <p><b>Judged on: </b>{t.kpi_notes}</p>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Metrics: who sees what (edits the proposal before approval)
// ---------------------------------------------------------------------------------------------

/** Same refs as the API: slug of the title, sorted by title then id, _2 for repeats. */
export function roleRefs(roles: OnboardingState["org"]["roles"]): { ref: string; title: string }[] {
  const out: { ref: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const r of [...roles].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))) {
    const base = r.title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "role";
    let ref = base,
      n = 2;
    while (seen.has(ref)) ref = `${base}_${n++}`;
    seen.add(ref);
    out.push({ ref, title: r.title });
  }
  return out;
}

type Cell = { on: boolean; alert: string; daily: boolean; weight: number };

/** "New metric" (design frame A15): plain words in, an AI-written and tested draft out. The draft
 * lands under "Custom for this workspace" in the metric library, where the team approves it. */
function NewMetricForm({ state, onDone }: { state: OnboardingState; onDone: (message?: string) => void }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [f, setF] = useState({ name: "", unit: "", department: "", threshold: "", direction: "infer", calc: "" });
  const archetypes = state.mappings.map((m) => m.archetype);
  const ready = f.name.trim() && f.calc.trim() && archetypes.length > 0;
  const submit = () =>
    start(async () => {
      setError(null);
      const parts = [f.calc.trim()];
      if (f.department) parts.push(`This metric is for the ${f.department} department.`);
      if (f.threshold.trim()) parts.push(`Alert when it changes by ${f.threshold.trim()}.`);
      const res = await draftCustomMetric(state.workspace.id, {
        name: f.name.trim(),
        archetypes,
        instructions: parts.join(" "),
        ...(f.unit.trim() ? { unit: f.unit.trim() } : {}),
        ...(f.direction === "infer" ? {} : { higher_is_better: f.direction === "higher" }),
      });
      if (!res.ok) return setError(res.error);
      router.refresh();
      onDone("Draft created and tested on the customer's data. Approve it in the metric library below.");
    });
  return (
    <div className="new-metric stage-form">
      <h4>New metric</h4>
      <div className="stage-fields">
        <label>
          Metric name
          <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </label>
        <label>
          Unit
          <input value={f.unit} placeholder="e.g. %, days, USD" onChange={(e) => setF({ ...f, unit: e.target.value })} />
        </label>
        <label>
          Department
          <select value={f.department} onChange={(e) => setF({ ...f, department: e.target.value })}>
            <option value="">Company-wide</option>
            {state.org.departments.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          Threshold
          <input value={f.threshold} placeholder="e.g. 10% change" onChange={(e) => setF({ ...f, threshold: e.target.value })} />
        </label>
      </div>
      <label>
        Improvement direction
        <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} style={{ maxWidth: 320 }}>
          <option value="infer">Infer from metric</option>
          <option value="higher">Higher is better</option>
          <option value="lower">Lower is better</option>
        </select>
      </label>
      <label>
        Calculation
        <textarea value={f.calc} placeholder="Describe how this metric is calculated." onChange={(e) => setF({ ...f, calc: e.target.value })} />
      </label>
      {error && <p className="stage-helper" role="alert">{error}</p>}
      <div className="stage-form-footer">
        <button type="button" className="btn btn-primary" disabled={!ready || pending} onClick={submit}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Icon name="check" size={16} />}
          <span>{pending ? "Drafting and testing…" : "Add to catalog"}</span>
        </button>
        <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => onDone()}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function WhoSeesWhat({ state, step, editable }: { state: OnboardingState; step: OnboardingStep; editable: boolean }) {
  const router = useRouter();
  const out = step.output as any;
  const roles = useMemo(() => roleRefs(state.org.roles), [state.org.roles]);
  const kind = (title: string) => state.org.roles.find((r) => r.title === title)?.holder_type;
  const initial = () => {
    const g: Record<string, { include: boolean; cells: Record<string, Cell> }> = {};
    for (const m of out.metrics) {
      const cells: Record<string, Cell> = {};
      for (const r of roles) {
        const a = m.attach.find((x: any) => x.role_ref === r.ref);
        cells[r.ref] = { on: !!a, alert: a?.threshold_value != null ? String(a.threshold_value) : "", daily: !!a?.daily_check, weight: a?.weight ?? 1 };
      }
      g[m.key] = { include: true, cells };
    }
    return g;
  };
  const [grid, setGrid] = useState(initial);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const [tab, setTab] = useState<"roles" | "catalog">("roles");
  const [adding, setAdding] = useState(false);
  const [roleRef, setRoleRef] = useState(roles[0]?.ref ?? "");
  const [search, setSearch] = useState("");
  const dirty = JSON.stringify(grid) !== JSON.stringify(initial());
  const set = (key: string, ref: string, patch: Partial<Cell>) =>
    setGrid((g) => ({ ...g, [key]: { ...g[key], cells: { ...g[key].cells, [ref]: { ...g[key].cells[ref], ...patch } } } }));

  const live = out.metrics.filter((m: any) => grid[m.key].include);
  const countFor = (ref: string) => live.filter((m: any) => grid[m.key].cells[ref].on).length;
  const withMetrics = roles.filter((r) => countFor(r.ref) > 0).length;
  const selected = roles.find((r) => r.ref === roleRef) ?? roles[0];
  const matches = roles.filter((r) => r.title.toLowerCase().includes(search.trim().toLowerCase()));

  const save = () =>
    start(async () => {
      const edits = out.metrics.map((m: any) => ({
        key: m.key,
        include: grid[m.key].include,
        attach: roles
          .filter((r) => grid[m.key].cells[r.ref].on)
          .map((r) => {
            const c = grid[m.key].cells[r.ref];
            return { role_ref: r.ref, weight: c.weight, daily_check: c.daily, threshold_value: c.alert.trim() === "" ? null : Number(c.alert.replaceAll(",", "")) };
          }),
      }));
      const res = await editMetricsProposal(state.workspace.id, step.id, edits);
      setMsg(res.ok ? "Saved as a new proposal. Check it, then publish." : res.error);
      router.refresh();
    });

  return (
    <section className="stage-panel stage-content-panel metric-panel">
      <div className="stage-panel-heading">
        <span className="stage-heading-icon">
          <Icon name="chart" size={19} />
        </span>
        <div>
          <h3>Metrics by role</h3>
          <p>Review and adjust which measures each role watches before the customer runs the trial.</p>
        </div>
      </div>
      {adding && (
        <NewMetricForm
          state={state}
          onDone={(message) => {
            setAdding(false);
            if (message) setMsg(message);
          }}
        />
      )}
      <dl className="source-totals metric-totals">
        <div>
          <dt>Roles with metrics</dt>
          <dd>
            {withMetrics}
            <small> / {roles.length}</small>
          </dd>
        </div>
        <div>
          <dt>Roles to assign</dt>
          <dd>{roles.length - withMetrics}</dd>
        </div>
        <div>
          <dt>Catalog metrics</dt>
          <dd>{live.length}</dd>
        </div>
      </dl>
      <div className="stage-segmented metric-tabs" role="group" aria-label="Metrics workspace view">
        <button type="button" aria-pressed={tab === "roles"} onClick={() => setTab("roles")}>
          <Icon name="network" size={15} /> Role assignments
        </button>
        <button type="button" aria-pressed={tab === "catalog"} onClick={() => setTab("catalog")}>
          <Icon name="activity" size={15} /> Metric catalog
        </button>
      </div>
      {!adding && (
        <button type="button" className="btn btn-secondary new-metric-open" disabled={!editable} onClick={() => setAdding(true)}>
          <Icon name="plus" size={15} /> New metric
        </button>
      )}

      {tab === "roles" && selected && (
        <div className="metric-workbench">
          <div className="metric-role-list">
            <label className="stage-search metric-role-search">
              <Icon name="search" size={15} />
              <input type="search" aria-label="Search roles" placeholder="Search roles" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <div className="metric-role-options">
              {matches.length ? (
                matches.map((r) => (
                  <button key={r.ref} type="button" className="metric-role-option" aria-pressed={r.ref === selected.ref} onClick={() => setRoleRef(r.ref)}>
                    <span className="metric-role-icon">
                      <Icon name={kind(r.title) === "vacant" ? "user" : "network"} size={15} />
                    </span>
                    <span>
                      <strong>{r.title}</strong>
                      <small>{kind(r.title) === "vacant" ? "Vacant" : "Filled"}</small>
                    </span>
                    <span className="metric-role-count">
                      {countFor(r.ref)}
                      <span className="stage-visually-hidden"> assigned</span>
                    </span>
                  </button>
                ))
              ) : (
                <p className="metric-list-empty">No roles match your search.</p>
              )}
            </div>
          </div>
          <div className="metric-role-editor">
            <div className="metric-role-heading">
              <div>
                <p>{kind(selected.title) === "vacant" ? "Vacant" : "Filled"}</p>
                <h4>{selected.title}</h4>
              </div>
              <span className={`stage-badge ${countFor(selected.ref) ? "positive" : "accent"}`}>{countFor(selected.ref) ? "Assigned" : "Suggested"}</span>
            </div>
            <p className="metric-role-description">
              Tick the measures this role gets cards for. Leave &ldquo;alert at&rdquo; empty to alert only when the value moves unusually (trend).
            </p>
            <fieldset>
              <legend className="stage-visually-hidden">Metrics for {selected.title}</legend>
              {live.map((m: any) => {
                const c = grid[m.key].cells[selected.ref];
                return (
                  <div key={m.key}>
                    <label className="metric-check">
                      <input type="checkbox" disabled={!editable} checked={c.on} onChange={(e) => set(m.key, selected.ref, { on: e.target.checked })} />
                      <span>
                        <strong>{m.name}</strong>
                        <small>
                          {m.unit} · {m.higher_is_better ? "higher is better" : "lower is better"} · {num(m.unit_value)} {state.workspace.currency} per unit
                        </small>
                      </span>
                    </label>
                    {c.on && (
                      <div className="mt-1.5 flex min-w-0 flex-col items-start gap-1.5 px-3 pb-2 text-xs">
                        <label className="flex w-full min-w-0 items-center gap-1.5">
                          <span className="shrink-0">Alert at</span>
                          <input
                            aria-label={`Alert level of ${m.name} for ${selected.title}`}
                            disabled={!editable}
                            value={c.alert}
                            onChange={(e) => set(m.key, selected.ref, { alert: e.target.value })}
                            placeholder="trend"
                            className="min-w-0 flex-1 rounded-lg border border-border bg-card px-2 py-1 tabular-nums"
                          />
                        </label>
                        <label className="flex items-center gap-1.5">
                          <input type="checkbox" disabled={!editable} checked={c.daily} onChange={(e) => set(m.key, selected.ref, { daily: e.target.checked })} /> also check daily
                        </label>
                      </div>
                    )}
                  </div>
                );
              })}
            </fieldset>
          </div>
        </div>
      )}

      {tab === "catalog" && (
        <div className="stage-metric-list">
          {out.metrics.map((m: any) => {
            const assigned = roles.filter((r) => grid[m.key].cells[r.ref].on);
            return (
              <details key={m.key} className="stage-disclosure stage-metric-row" style={{ opacity: grid[m.key].include ? 1 : 0.5 }}>
                <summary>
                  <span className="stage-heading-icon">
                    <Icon name="activity" size={17} />
                  </span>
                  <span>
                    <strong>{m.name}</strong>
                    <small>
                      {m.unit} · {m.higher_is_better ? "higher is better" : "lower is better"}
                    </small>
                  </span>
                  <span className={`stage-badge ${assigned.length ? "positive" : ""}`}>
                    {assigned.length} {assigned.length === 1 ? "role" : "roles"}
                  </span>
                  <Icon name="chevron-down" size={15} />
                </summary>
                <div className="stage-form stage-metric-form">
                  <div className="metric-catalog-roles">
                    <span>Assigned roles</span>
                    <div>
                      {assigned.length ? assigned.map((r) => <span key={r.ref} className="metric-chip">{r.title}</span>) : <small>No assignments yet.</small>}
                    </div>
                  </div>
                  <p className="stage-helper">
                    Calculation: <code>{m.template}</code> · {num(m.unit_value)} {state.workspace.currency} per unit
                  </p>
                  <label className="metric-check">
                    <input
                      type="checkbox"
                      disabled={!editable}
                      checked={grid[m.key].include}
                      onChange={(e) => setGrid((g) => ({ ...g, [m.key]: { ...g[m.key], include: e.target.checked } }))}
                    />
                    <span>
                      <strong>Turn this measure on</strong>
                      <small>Untick to leave it out of this workspace.</small>
                    </span>
                  </label>
                </div>
              </details>
            );
          })}
        </div>
      )}

      {out.skipped?.length > 0 && (
        <p className="stage-helper">Not turned on: {out.skipped.map((x: any) => `${x.template} (${x.reason})`).join("; ")}</p>
      )}
      {editable && (
        <div className="stage-form-footer">
          <button type="button" className="btn btn-secondary" disabled={!dirty || pending} onClick={save}>
            {pending ? <LoaderCircle className="animate-spin" /> : <Icon name="check" size={17} />}
            <span>Save changes as a new proposal</span>
          </button>
          {dirty && (
            <button type="button" className="stage-inline-link" onClick={() => setGrid(initial())}>
              Undo changes
            </button>
          )}
          {msg && <span className="stage-helper">{msg}</span>}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// Rules: plain settings, edited before approval
// ---------------------------------------------------------------------------------------------

type Row = { key: string; value: string; reason: string; current: unknown };

export function RulesEditor({ state, step, guide, editable }: { state: OnboardingState; step: OnboardingStep; guide: OnboardingGuide | null; editable: boolean }) {
  const router = useRouter();
  const out = step.output as any;
  const settings = Object.fromEntries((guide?.rule_settings ?? []).map((s) => [s.key, s]));
  const initial = (): Row[] => out.changes.map((c: any) => ({ key: c.key, value: String(c.clean_value ?? c.value), reason: c.reason, current: c.current }));
  const [rows, setRows] = useState<Row[]>(initial);
  const [adding, setAdding] = useState("");
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const dirty = JSON.stringify(rows) !== JSON.stringify(initial());
  const used = new Set(rows.map((r) => r.key));

  const save = () =>
    start(async () => {
      const res = await editRulesProposal(
        state.workspace.id,
        step.id,
        rows.map((r) => ({ key: r.key, value: Number(r.value.replaceAll(",", "")), reason: r.reason })),
      );
      setMsg(res.ok ? "Saved as a new proposal. Check it, then approve." : res.error);
      router.refresh();
    });

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Rules decide how many cards people get and how big a problem must be. Each change below replaces our standard value for this client only.
      </p>
      <ul className="space-y-2">
        {rows.map((r, i) => {
          const s = settings[r.key];
          return (
            <li key={r.key} className="node-pop grid gap-2 rounded-xl bg-surface p-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0 space-y-1">
                <p className="font-semibold">{s?.label ?? r.key}</p>
                {s && <p className="text-xs text-muted-foreground">{s.help}</p>}
                <p className="text-xs">
                  <b>Why: </b>
                  {r.reason}
                </p>
              </div>
              <div className="flex items-start gap-2">
                <div className="text-right text-xs">
                  <p className="text-muted-foreground">standard {num(r.current)}</p>
                  {s && <p className="text-muted-foreground">allowed {num(s.minimum)}–{num(s.maximum)} {s.unit}</p>}
                </div>
                <input
                  aria-label={s?.label ?? r.key}
                  disabled={!editable}
                  value={r.value}
                  onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
                  className={cn(FIELD, "w-28 tabular-nums")}
                />
                {editable && (
                  <Button size="icon-sm" variant="ghost" aria-label="Remove change" onClick={() => setRows(rows.filter((_, j) => j !== i))}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </li>
          );
        })}
        {rows.length === 0 && <li className="text-sm text-muted-foreground">No changes: this client keeps our standard rules.</li>}
      </ul>
      {(out.kept?.length > 0 || out.risks?.length > 0) && (
        <div className="grid gap-2 sm:grid-cols-2">
          {out.kept?.length > 0 && (
            <div className="rounded-xl bg-surface p-3 text-xs">
              <p className="mb-1 font-semibold">Kept on purpose</p>
              <ul className="list-disc space-y-0.5 pl-4">{out.kept.map((k: any) => <li key={k.key}>{settings[k.key]?.label ?? k.key}: {k.why}</li>)}</ul>
            </div>
          )}
          {out.risks?.length > 0 && (
            <div className={cn("rounded-xl p-3 text-xs", TONE.partial)}>
              <p className="mb-1 font-semibold">Risks</p>
              <ul className="list-disc space-y-0.5 pl-4">{out.risks.map((r: string) => <li key={r}>{r}</li>)}</ul>
            </div>
          )}
        </div>
      )}
      {editable && (
        <div className="flex flex-wrap items-center gap-2">
          <select value={adding} onChange={(e) => setAdding(e.target.value)} className={FIELD} aria-label="Add a rule">
            <option value="">Add a rule…</option>
            {(guide?.rule_settings ?? []).filter((s) => !used.has(s.key)).map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
          <Button
            size="sm"
            variant="ghost"
            disabled={!adding}
            onClick={() => {
              setRows([...rows, { key: adding, value: String(settings[adding]?.minimum ?? 0), reason: "set by our team", current: "–" }]);
              setAdding("");
            }}
          >
            <Plus /> Add
          </Button>
          <Button size="sm" variant="outline" disabled={!dirty || pending} onClick={save} className="ml-auto">
            {pending ? <LoaderCircle className="animate-spin" /> : <Save />} Save changes as a new proposal
          </Button>
          {msg && <span className="w-full text-xs text-muted-foreground">{msg}</span>}
        </div>
      )}
      {!editable && rows.length > 0 && <Pill tone="neutral">read-only: reopen the step to change rules</Pill>}
    </div>
  );
}
