"use client";

import { LoaderCircle, Plus, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { addMeasure, suggestMeasures } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { MeasureAdvice } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const FIELD =
  "rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";

type Template = { key: string; description: string; playbook: string };
type RoleRow = { on: boolean; level: string; daily: boolean };

/** Add a measure to a live workspace: by hand from the catalog, or start from an AI suggestion.
 * The AI only suggests; the measure is added when someone presses Add (ADR 0029). */
export function MeasureManager({
  workspaceId,
  templates,
  roles,
  watched,
  currency,
  can,
}: {
  workspaceId: string;
  templates: Template[];
  roles: { id: string; title: string }[];
  watched: string[];
  currency: string;
  can: boolean;
}) {
  const router = useRouter();
  const free = templates.filter((t) => !watched.includes(t.key));
  const [template, setTemplate] = useState("");
  const [name, setName] = useState("");
  const [unit, setUnit] = useState(currency);
  const [higher, setHigher] = useState(false);
  const [rows, setRows] = useState<Record<string, RoleRow>>({});
  const [goal, setGoal] = useState("");
  const [advice, setAdvice] = useState<MeasureAdvice | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const t = free.find((x) => x.key === template);
  const row = (id: string): RoleRow => rows[id] ?? { on: false, level: "", daily: false };
  const set = (id: string, patch: Partial<RoleRow>) => setRows((r) => ({ ...r, [id]: { ...row(id), ...patch } }));

  const startFrom = (i: MeasureAdvice["suggestions"][number]) => {
    setTemplate(i.template);
    setName(i.name);
    setRows(Object.fromEntries(roles.filter((r) => i.roles.includes(r.title)).map((r) => [r.id, { on: true, level: "", daily: false }])));
    setMsg({ ok: true, text: `Filled from the suggestion. Alert idea: ${i.alert} Set a level per role, or leave it empty for trend only.` });
  };

  return (
    <section className="space-y-4 rounded-xl bg-card p-4 shadow-card">
      <div className="space-y-1">
        <h3 className="text-sm font-semibold">Add a measure</h3>
        <p className="text-xs text-muted-foreground">
          Pick a measure this workspace&apos;s data can feed and the roles that should see it. An empty alert level means
          trend only: a card when the value moves unusually for that place.
        </p>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await suggestMeasures(workspaceId, goal);
            setAdvice(r.ok ? r.data! : null);
            setMsg(r.ok ? null : { ok: false, text: r.error });
          });
        }}
      >
        <input
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
          placeholder="Ask the AI: what else should we watch? (optional goal)"
          className={cn(FIELD, "min-w-64 flex-1")}
        />
        <Button size="sm" type="submit" variant="outline" disabled={pending || !free.length}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Suggest
        </Button>
      </form>
      {advice && (
        <div className="node-pop space-y-2">
          <p className="text-sm text-muted-foreground">{advice.summary}</p>
          {advice.suggestions.map((i) => (
            <div key={i.template + i.name} className="flex flex-wrap items-start gap-3 rounded-lg bg-surface px-3 py-2 text-sm">
              <span className="min-w-0 flex-1">
                <span className="font-medium">{i.name}</span>
                <span className="text-muted-foreground"> · for {i.roles.join(", ") || "no role yet"}</span>
                <span className="block text-xs text-muted-foreground">{i.why}</span>
              </span>
              <Button size="sm" variant="outline" onClick={() => startFrom(i)}>
                Start from this
              </Button>
            </div>
          ))}
        </div>
      )}

      {free.length === 0 ? (
        <p className="text-xs text-muted-foreground">Every measure this workspace&apos;s data can feed is already watched.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <select value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Measure" className={cn(FIELD, "min-w-56")}>
              <option value="">Pick a measure…</option>
              {free.map((x) => (
                <option key={x.key} value={x.key}>
                  {x.key.replaceAll("_", " ")}
                </option>
              ))}
            </select>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Name people see" className={cn(FIELD, "min-w-56 flex-1")} />
            <input value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Unit" className={cn(FIELD, "w-28")} />
            <label className="flex items-center gap-2 text-xs">
              <input type="checkbox" checked={higher} onChange={(e) => setHigher(e.target.checked)} /> Higher is better
            </label>
          </div>
          {t && <p className="text-xs text-muted-foreground">{t.description}</p>}
          {template && (
            <ul className="node-pop divide-y divide-border/60 rounded-lg bg-surface">
              {roles.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <label className="flex min-w-48 flex-1 items-center gap-2">
                    <input type="checkbox" checked={row(r.id).on} onChange={(e) => set(r.id, { on: e.target.checked })} /> {r.title}
                  </label>
                  {row(r.id).on && (
                    <>
                      <input
                        value={row(r.id).level}
                        onChange={(e) => set(r.id, { level: e.target.value })}
                        placeholder="Alert level (empty = trend)"
                        className="w-48 rounded-md bg-card px-2 py-1 text-sm shadow-inner outline-none"
                      />
                      <label className="flex items-center gap-1.5 text-xs">
                        <input type="checkbox" checked={row(r.id).daily} onChange={(e) => set(r.id, { daily: e.target.checked })} /> daily
                      </label>
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Button
            size="sm"
            disabled={!can || pending || !template || !roles.some((r) => row(r.id).on)}
            onClick={() =>
              start(async () => {
                const res = await addMeasure(workspaceId, {
                  template,
                  name,
                  unit,
                  higher_is_better: higher,
                  unit_value: 1,
                  roles: roles
                    .filter((r) => row(r.id).on)
                    .map((r) => ({
                      role_id: r.id,
                      weight: 1,
                      threshold: row(r.id).level.trim() ? Number(row(r.id).level.replaceAll(",", "")) : null,
                      daily_check: row(r.id).daily,
                    })),
                });
                setMsg(res.ok ? { ok: true, text: "Added. The next run computes it." } : { ok: false, text: res.error });
                if (res.ok) {
                  setTemplate("");
                  setName("");
                  setRows({});
                  router.refresh();
                }
              })
            }
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Plus />} Add
          </Button>
        </div>
      )}
      {msg && <p className={cn("text-xs", msg.ok ? "text-muted-foreground" : "text-brand")}>{msg.text}</p>}
    </section>
  );
}
