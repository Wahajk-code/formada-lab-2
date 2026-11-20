"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import {
  addLibraryMetric,
  approveCustomMetric,
  draftCustomMetric,
  editCustomMetric,
  loadMetricLibrary,
  removePlanMetric,
  retireCustomMetric,
} from "@/app/console-actions";
import { roleRefs } from "@/components/console/onboarding/editors";
import { Pill } from "@/components/onboarding/tone";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { CustomMetric, LibraryMetric, MetricLibrary as Library, OnboardingState, OnboardingStep } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const FIELD = "rounded-lg bg-surface px-2 py-1.5 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";
const label = (key: string) => key.replace(/_/g, " ");

/** The metrics each kind of customer data can feed: found, not found, and ones we add by hand.
 * "Found" means the mapped data has what the calculation needs. Everything stays inside this
 * workspace. Custom metrics never change the shared catalog. */
export function MetricLibrary({ state, step, editable }: { state: OnboardingState; step: OnboardingStep; editable: boolean }) {
  const router = useRouter();
  const id = state.workspace.id;
  const roles = roleRefs(state.org.roles);
  const [lib, setLib] = useState<Library | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [owner, setOwner] = useState<Record<string, string>>({});
  const [adding, setAdding] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; instructions: string; sql: string; archetypes: string[]; byHand: boolean } | null>(null);
  const [editing, setEditing] = useState<{ id: string; sql: string } | null>(null);

  const reload = () =>
    loadMetricLibrary(id).then((res) => {
      if (res.ok && res.data) {
        setLib(res.data);
        setError(null);
      } else if (!res.ok) setError(res.error);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when the proposal changes
  useEffect(() => void reload(), [id, step.id]);

  const run = (job: () => Promise<{ ok: boolean; error?: string }>, done: string) =>
    start(async () => {
      const res = await job();
      setMsg(res.ok ? done : (res.error ?? "Something went wrong."));
      if (res.ok) {
        setAdding(null);
        setForm(null);
        setEditing(null);
        router.refresh();
        await reload();
      }
    });

  if (error) return <p className="text-xs text-brand">Could not load the metric library: {error}</p>;
  if (!lib) return <p className="text-xs text-muted-foreground">Loading the metric library…</p>;

  const planned = (step.output as { metrics?: { key: string; template: string }[] } | null)?.metrics ?? [];
  const planKey = (template: string | null) => planned.find((p) => p.template === template)?.key;
  const mappedKinds = lib.archetypes.filter((a) => a.mapped).map((a) => a.archetype);
  const add = (m: LibraryMetric | CustomMetric) => {
    const template = "template" in m ? m.template : m.key;
    const role = owner[m.key] ?? roles[0]?.ref;
    if (!template || !role) return;
    run(() => addLibraryMetric(id, step.id, { template, roles: [role] }), "Added to the plan as a new proposal. Set the money value, then publish.");
  };

  return (
    <section className="stage-panel stage-content-panel space-y-4">
      <div className="stage-panel-heading">
        <span className="stage-heading-icon">
          <Icon name="layers-minimalistic" size={19} />
        </span>
        <div>
          <h3>Metric library</h3>
          <p>What this customer&apos;s data can measure. Add or remove metrics, or build one just for this workspace.</p>
        </div>
      </div>

      <dl className="source-totals">
        <div>
          <dt>Found</dt>
          <dd>{lib.summary.found}<small> / {lib.summary.total}</small></dd>
        </div>
        <div>
          <dt>Not found</dt>
          <dd>{lib.summary.not_found}</dd>
        </div>
        <div>
          <dt>Custom</dt>
          <dd>{lib.custom.filter((c) => c.status !== "retired").length}</dd>
        </div>
      </dl>
      {msg && <p className="text-xs text-muted-foreground" role="status">{msg}</p>}

      {lib.archetypes.map((g) => (
        <div key={g.archetype} className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{label(g.archetype)}</h4>
            <Pill tone={g.mapped ? "good" : "neutral"}>{g.mapped ? `${g.summary.found} of ${g.summary.total} found` : "not mapped"}</Pill>
          </div>
          <ul className="space-y-1.5">
            {g.metrics.map((m) => {
              const found = m.status === "found";
              return (
                <li key={m.key} className={cn("rounded-xl bg-surface p-3 text-sm", !found && "opacity-60")}>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{m.name.en}</span>
                    <Pill tone={found ? "good" : "neutral"}>{found ? "Found" : "Not found"}</Pill>
                    {found && m.state === "in_plan" && <Pill tone="matched">In the plan</Pill>}
                    <span className="ml-auto flex items-center gap-2">
                      {editable && found && m.state === "in_plan" && (
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => {
                          const key = planKey(m.template);
                          if (key) run(() => removePlanMetric(id, step.id, key), "Removed from the plan.");
                        }}>
                          <Icon name="trash-bin-trash" size={14} /> Remove
                        </Button>
                      )}
                      {editable && found && m.state !== "in_plan" && (
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => setAdding(adding === m.key ? null : m.key)}>
                          <Icon name="add" size={14} /> Add
                        </Button>
                      )}
                      {editable && !found && m.reason === "no_template" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() =>
                            setForm({ name: m.name.en, instructions: m.why.en ?? "", sql: "", archetypes: [g.archetype], byHand: false })
                          }
                        >
                          Build it
                        </Button>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{found ? m.why.en : m.message}</p>
                  {adding === m.key && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <label htmlFor={`own-${m.key}`}>Owned by</label>
                      <select id={`own-${m.key}`} className={FIELD} value={owner[m.key] ?? roles[0]?.ref} onChange={(e) => setOwner({ ...owner, [m.key]: e.target.value })}>
                        {roles.map((r) => (
                          <option key={r.ref} value={r.ref}>{r.title}</option>
                        ))}
                      </select>
                      <Button size="sm" disabled={pending} onClick={() => add(m)}>Add to plan</Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Custom for this workspace</h4>
          {editable && !form && (
            <Button size="sm" variant="outline" onClick={() => setForm({ name: "", instructions: "", sql: "", archetypes: mappedKinds.slice(0, 1), byHand: false })}>
              <Icon name="add" size={14} /> New custom metric
            </Button>
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Only this workspace sees these. They are never added to a data type. The AI drafts the calculation, code checks it and runs it once on the customer&apos;s data, then
          our team approves it. An approved one is frozen.
        </p>

        {form && (
          <div className="space-y-2 rounded-xl bg-surface p-3 text-sm">
            <label className="block text-xs font-medium" htmlFor="cm-name">Name</label>
            <input id="cm-name" className={cn(FIELD, "w-full")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Example: Empty shelves at flagship stores" />
            <fieldset className="flex flex-wrap gap-3 text-xs">
              <legend className="mb-1 font-medium">Reads from</legend>
              {mappedKinds.map((k) => (
                <label key={k} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    checked={form.archetypes.includes(k)}
                    onChange={(e) =>
                      setForm({ ...form, archetypes: e.target.checked ? [...form.archetypes, k] : form.archetypes.filter((x) => x !== k) })
                    }
                  />
                  {label(k)}
                </label>
              ))}
            </fieldset>
            <div className="stage-segmented" role="group" aria-label="How to build it">
              <button type="button" aria-pressed={!form.byHand} onClick={() => setForm({ ...form, byHand: false })}>Write it with AI</button>
              <button type="button" aria-pressed={form.byHand} onClick={() => setForm({ ...form, byHand: true })}>I&apos;ll write the SQL</button>
            </div>
            {form.byHand ? (
              <>
                <label className="block text-xs font-medium" htmlFor="cm-sql">SQL (use {"{{t.field}}"} placeholders, %(period_end)s and %(row_cap)s)</label>
                <textarea id="cm-sql" className={cn(FIELD, "h-40 w-full font-mono text-xs")} value={form.sql} onChange={(e) => setForm({ ...form, sql: e.target.value })} />
              </>
            ) : (
              <>
                <label className="block text-xs font-medium" htmlFor="cm-ins">What should it show? Plain words</label>
                <textarea id="cm-ins" className={cn(FIELD, "h-24 w-full")} value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Per store and week, the share of items with nothing available. A rise is bad." />
              </>
            )}
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={pending || !form.name.trim() || form.archetypes.length === 0 || (form.byHand ? !form.sql.trim() : !form.instructions.trim())}
                onClick={() =>
                  run(
                    () =>
                      draftCustomMetric(id, {
                        name: form.name,
                        archetypes: form.archetypes,
                        ...(form.byHand ? { sql: form.sql } : { instructions: form.instructions }),
                      }),
                    "Draft created and tested on the customer's data. Check it, then approve.",
                  )
                }
              >
                {pending ? "Working…" : form.byHand ? "Check my SQL" : "Draft it"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setForm(null)}>Cancel</Button>
            </div>
          </div>
        )}

        <ul className="space-y-1.5">
          {lib.custom
            .filter((c) => c.status !== "retired")
            .map((c) => {
              const dry = c.dry_run;
              return (
                <li key={c.id} className="rounded-xl bg-surface p-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{c.name}</span>
                    <span className="font-mono text-[11px] text-muted-foreground">{c.key} v{c.version}</span>
                    <Pill tone={c.status === "approved" ? "good" : "partial"}>{c.status === "approved" ? "Approved, frozen" : "Draft"}</Pill>
                    <Pill tone="neutral">{c.origin === "ai" ? "Written by AI" : "Written by hand"}</Pill>
                    {c.state === "in_plan" && <Pill tone="matched">In the plan</Pill>}
                    <span className="ml-auto flex items-center gap-2">
                      {editable && c.status === "draft" && (
                        <>
                          <Button size="sm" variant="outline" disabled={pending} onClick={() => setEditing(editing?.id === c.id ? null : { id: c.id, sql: c.sql })}>
                            <Icon name="pen" size={14} /> Edit SQL
                          </Button>
                          <Button size="sm" disabled={pending || !dry?.ok} onClick={() => run(() => approveCustomMetric(id, c.id), "Approved. It is frozen now and can be added to the plan.")}>
                            <Icon name="check" size={14} /> Approve
                          </Button>
                          <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => retireCustomMetric(id, c.id), "Draft discarded.")}>
                            Discard
                          </Button>
                        </>
                      )}
                      {editable && c.status === "approved" && c.state !== "in_plan" && (
                        <Button size="sm" variant="outline" disabled={pending} onClick={() => setAdding(adding === c.key ? null : c.key)}>
                          <Icon name="add" size={14} /> Add
                        </Button>
                      )}
                      {editable && c.status === "approved" && c.state === "in_plan" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={pending}
                          onClick={() => {
                            const key = planKey(c.key);
                            if (key) run(() => removePlanMetric(id, step.id, key), "Removed from the plan.");
                          }}
                        >
                          <Icon name="trash-bin-trash" size={14} /> Remove
                        </Button>
                      )}
                    </span>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">{c.description}</p>
                  {dry && (
                    <p className={cn("mt-1 text-xs", dry.ok ? "text-muted-foreground" : "text-brand")}>
                      {dry.ok ? `Test run passed: ${dry.entities} entities over ${dry.weeks} weeks (${dry.rows} rows).` : `Test run failed: ${dry.error}`}
                    </p>
                  )}
                  <details className="mt-1 text-xs">
                    <summary className="cursor-pointer text-muted-foreground">Calculation</summary>
                    <pre className="mt-1 overflow-x-auto rounded-lg bg-card p-2 font-mono text-[11px]">{c.sql}</pre>
                  </details>
                  {editing?.id === c.id && (
                    <div className="mt-2 space-y-2">
                      <label className="sr-only" htmlFor={`sql-${c.id}`}>SQL</label>
                      <textarea id={`sql-${c.id}`} className={cn(FIELD, "h-40 w-full font-mono text-xs")} value={editing.sql} onChange={(e) => setEditing({ id: c.id, sql: e.target.value })} />
                      <Button size="sm" disabled={pending} onClick={() => run(() => editCustomMetric(id, c.id, { sql: editing.sql }), "Saved as a new draft and tested again.")}>
                        Save and test again
                      </Button>
                    </div>
                  )}
                  {adding === c.key && (
                    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
                      <label htmlFor={`own-${c.key}`}>Owned by</label>
                      <select id={`own-${c.key}`} className={FIELD} value={owner[c.key] ?? roles[0]?.ref} onChange={(e) => setOwner({ ...owner, [c.key]: e.target.value })}>
                        {roles.map((r) => (
                          <option key={r.ref} value={r.ref}>{r.title}</option>
                        ))}
                      </select>
                      <Button size="sm" disabled={pending} onClick={() => add(c)}>Add to plan</Button>
                    </div>
                  )}
                </li>
              );
            })}
          {lib.custom.filter((c) => c.status !== "retired").length === 0 && !form && (
            <li className="rounded-xl bg-surface p-3 text-xs text-muted-foreground">No custom metrics yet.</li>
          )}
        </ul>
      </div>
    </section>
  );
}
