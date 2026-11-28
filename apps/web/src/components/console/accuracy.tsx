"use client";

import { LoaderCircle, Play, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { useState, useTransition } from "react";

import {
  checkControlTotals,
  removeControlTotal,
  runBacktest,
  runRegression,
  runStability,
  saveControlTotal,
} from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { Accuracy, AccuracyStatus, ControlRow, ValidationRow } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const STEPS = ["discovery", "mapping", "org", "metrics", "rules"] as const;
const STATUS_WORD: Record<AccuracyStatus, string> = { good: "Fine", watch: "Look", bad: "Not yet", none: "Not measured" };
const VERDICT_WORD: Record<string, string> = {
  stable: "Stable",
  mostly: "Mostly the same",
  unstable: "Changes between runs",
  holds: "Holds",
  regressed: "Got worse",
  good: "Catches incidents",
  reasonable: "Reasonable",
  noisy: "Too noisy",
  misses: "Misses incidents",
  too_short: "Too little history",
  failed: "No answer",
};
const BAD_VERDICTS = ["unstable", "regressed", "misses", "failed"];
const when = (iso: string) => new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
const num = (v: number | null | undefined) => (v === null || v === undefined ? "–" : v.toLocaleString("en-CA", { maximumFractionDigits: 2 }));
const inputClass = "rounded-md border border-input bg-card px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-ring/30";

function Mark({ status }: { status: AccuracyStatus }) {
  return (
    <span
      className={cn(
        "inline-flex min-w-20 justify-center rounded-full px-2 py-0.5 text-[11px] font-medium",
        status === "good" && "border border-border bg-card",
        status === "watch" && "bg-surface-strong",
        status === "bad" && "bg-brand text-brand-foreground",
        status === "none" && "text-muted-foreground",
      )}
    >
      {STATUS_WORD[status]}
    </span>
  );
}

function Verdict({ value }: { value: string }) {
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", BAD_VERDICTS.includes(value) ? "bg-brand text-brand-foreground" : "bg-surface-strong")}>
      {VERDICT_WORD[value] ?? value}
    </span>
  );
}

/** One page per client for "can we trust these numbers?" (docs/how-we-validate.md): the six pieces
 *  of evidence, the client's own control totals, and the tests the team can run. */
export function AccuracyView({ workspaceId: id, data }: { workspaceId: string; data: Accuracy }) {
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(label: string, fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    setBusy(label);
    start(async () => {
      const res = await fn();
      if (!res.ok) setError(res.error ?? "Something went wrong.");
      setBusy(null);
    });
  }
  const working = (label: string) => pending && busy === label;

  return (
    <div className="space-y-6">
      <section
        className={cn(
          "flex items-start gap-3 rounded-2xl p-4 shadow-card",
          data.overall.status === "bad" ? "bg-brand text-brand-foreground" : "bg-surface",
        )}
      >
        <ShieldCheck className="mt-0.5 size-5 shrink-0" />
        <div>
          <p className="text-sm font-semibold">{data.overall.text}</p>
          <p className={cn("text-xs", data.overall.status === "bad" ? "opacity-80" : "text-muted-foreground")}>
            The worst measured piece decides, so a gap never hides behind a good average. Pieces not measured yet are not counted as fine.
          </p>
        </div>
      </section>

      {error && <p className="rounded-xl bg-brand/10 px-4 py-2 text-sm text-brand">{error}</p>}

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">The six checks</h2>
        <ul className="divide-y divide-border overflow-hidden rounded-xl bg-card shadow-card">
          {data.layers.map((l) => (
            <li key={l.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3 text-sm">
              <Mark status={l.status} />
              <span className="min-w-0 flex-1 basis-60">
                <span className="font-medium">{l.label}</span>
                <span className="block text-xs text-muted-foreground">{l.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold">Control totals</h2>
            <p className="text-xs text-muted-foreground">
              Figures the client already trusts. Every run compares our number with each one. Allowed difference unless set per figure: {data.default_tolerance_pct}%.
            </p>
          </div>
          <Button size="sm" variant="outline" disabled={pending || !data.controls.length} onClick={() => run("check", () => checkControlTotals(id))}>
            {working("check") ? <LoaderCircle className="animate-spin" /> : <Play />} Check now
          </Button>
        </div>
        {data.controls.length ? (
          <div className="overflow-x-auto rounded-xl bg-card shadow-card">
            <table className="w-full min-w-[46rem] text-sm">
              <thead className="text-left text-xs text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 font-medium">Figure</th>
                  <th className="px-3 py-2 font-medium">Metric · week</th>
                  <th className="px-3 py-2 text-right font-medium">Client says</th>
                  <th className="px-3 py-2 text-right font-medium">We say</th>
                  <th className="px-3 py-2 font-medium">Result</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.controls.map((c) => (
                  <ControlLine key={c.key} c={c} onRemove={() => run(`rm-${c.key}`, () => removeControlTotal(id, c.key))} removing={working(`rm-${c.key}`)} />
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="rounded-xl bg-surface px-4 py-3 text-sm text-muted-foreground">
            None yet. At onboarding, ask the client for three or four figures from their own reports (net sales for a recent week, units on hand today, open purchase orders) and add them here.
          </p>
        )}
        <AddControl id={id} metrics={data.metrics} run={run} working={working("add")} />
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">What owners say · last {data.window_days} days</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Tile label="Cards rated" value={`${data.people.rated} of ${data.people.cards}`} />
          <Tile label="Acted on" value={data.people.action_rate_pct === null ? "–" : `${data.people.action_rate_pct}%`} />
          <Tile label="Not relevant" value={data.people.not_relevant_pct === null ? "–" : `${data.people.not_relevant_pct}%`} />
          <Tile label="Number looks wrong" value={data.people.wrong_number_pct === null ? "–" : `${data.people.wrong_number_pct}%`} note={`${data.people.wrong_number} reports`} />
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Tests</h2>
        <TestBlock
          title="Detection on the client's history"
          help="Replays our signal detection week by week on the history we hold. Free: it reads stored numbers only."
          rows={data.tests.backtest}
          action={
            <Button size="sm" variant="outline" disabled={pending} onClick={() => run("backtest", () => runBacktest(id, null, []))}>
              {working("backtest") ? <LoaderCircle className="animate-spin" /> : <Play />} Replay every metric
            </Button>
          }
          line={(r) => `${r.summary.why ?? ""}`}
        />
        <TestBlock
          title="Same answer when asked twice"
          help="Asks one AI step twice on the same input and compares the decisions. Two AI calls: it costs money."
          rows={data.tests.stability}
          action={<StepButtons label="Ask twice" busy={busy} pending={pending} run={(step) => run(`stab-${step}`, () => runStability(id, step))} prefix="stab-" />}
          line={(r) => (r.summary.agreement_pct === undefined ? `${r.summary.why ?? ""}` : `${r.summary.agreement_pct}% of ${r.summary.decisions} decisions agree · $${num(r.summary.cost_usd)}`)}
        />
        <TestBlock
          title="Approved answers still reproduced"
          help="Replays the prompt on the input of the answer the team approved and scores how much of it comes back. One AI call: it costs money."
          rows={data.tests.regression}
          action={<StepButtons label="Replay" busy={busy} pending={pending} run={(step) => run(`reg-${step}`, () => runRegression(id, step, null))} prefix="reg-" />}
          line={(r) => (r.summary.agreement_pct === undefined || r.summary.agreement_pct === null ? `${r.summary.why ?? ""}` : `${r.summary.agreement_pct}% of the approved decisions reproduced · ${r.summary.prompt ?? ""}`)}
        />
      </section>
    </div>
  );
}

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl bg-card px-4 py-3 shadow-card">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}

function ControlLine({ c, onRemove, removing }: { c: ControlRow; onRemove: () => void; removing: boolean }) {
  const last = c.last;
  return (
    <tr className="align-top">
      <td className="px-3 py-2">
        <p className="font-medium">{c.name}</p>
        {c.source && <p className="text-xs text-muted-foreground">{c.source}</p>}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {c.metric_key}
        {c.entity && <> · {c.entity}</>}
        <br />
        {c.week ?? "latest week"}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">{num(c.expected)}</td>
      <td className="px-3 py-2 text-right tabular-nums">{last ? num(last.ours) : "–"}</td>
      <td className="px-3 py-2">
        {last ? (
          <>
            <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", last.status === "match" ? "border border-border" : "bg-brand text-brand-foreground")}>
              {last.status === "match" ? "Matches" : last.status === "off" ? "Off" : "No number"}
            </span>
            <p className="mt-1 text-xs text-muted-foreground">{last.says}</p>
          </>
        ) : (
          <span className="text-xs text-muted-foreground">Not checked yet</span>
        )}
      </td>
      <td className="px-3 py-2 text-right">
        <Button size="icon-xs" variant="ghost" aria-label={`Remove ${c.name}`} disabled={removing} onClick={onRemove}>
          {removing ? <LoaderCircle className="animate-spin" /> : <Trash2 />}
        </Button>
      </td>
    </tr>
  );
}

function AddControl({
  id,
  metrics,
  run,
  working,
}: {
  id: string;
  metrics: Accuracy["metrics"];
  run: (label: string, fn: () => Promise<{ ok: boolean; error?: string }>) => void;
  working: boolean;
}) {
  const [f, setF] = useState({ name: "", metric: metrics[0]?.key ?? "", entity: "", week: "", expected: "", tolerance: "", source: "" });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const ready = f.name.trim().length > 1 && f.metric && f.expected !== "" && !Number.isNaN(Number(f.expected));
  return (
    <details className="rounded-xl bg-surface px-4 py-3 text-sm">
      <summary className="flex cursor-pointer items-center gap-2 font-medium">
        <Plus className="size-4" /> Add a control total
      </summary>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted-foreground">
          Name
          <input className={cn(inputClass, "block w-full text-foreground")} value={f.name} onChange={set("name")} placeholder="Net sales, week of Nov 9" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Metric
          <select className={cn(inputClass, "block w-full text-foreground")} value={f.metric} onChange={set("metric")}>
            {metrics.map((m) => (
              <option key={m.key} value={m.key}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          The client&apos;s figure
          <input className={cn(inputClass, "block w-full text-foreground")} inputMode="decimal" value={f.expected} onChange={set("expected")} placeholder="412300" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Week (first day, optional: empty means the latest week)
          <input className={cn(inputClass, "block w-full text-foreground")} type="date" value={f.week} onChange={set("week")} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          One entity only (optional: empty adds every entity up)
          <input className={cn(inputClass, "block w-full text-foreground")} value={f.entity} onChange={set("entity")} placeholder="a SKU, a store…" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          Allowed difference in % (optional)
          <input className={cn(inputClass, "block w-full text-foreground")} inputMode="decimal" value={f.tolerance} onChange={set("tolerance")} placeholder="default" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground sm:col-span-2">
          Where the figure comes from
          <input className={cn(inputClass, "block w-full text-foreground")} value={f.source} onChange={set("source")} placeholder="Finance weekly report, sent by the client on Nov 17" />
        </label>
      </div>
      <p className="mt-2 text-xs text-muted-foreground">Only the sum of an additive figure (sales, units) can be checked without naming an entity. A ratio needs its entity.</p>
      <Button
        size="sm"
        className="mt-3"
        disabled={!ready || working}
        onClick={() =>
          run("add", () =>
            saveControlTotal(id, {
              key: f.name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 80),
              name: f.name.trim(),
              metric_key: f.metric,
              entity: f.entity.trim() || null,
              week: f.week || null,
              expected: Number(f.expected),
              tolerance_pct: f.tolerance === "" ? null : Number(f.tolerance),
              source: f.source.trim(),
            }),
          )
        }
      >
        {working ? <LoaderCircle className="animate-spin" /> : <Plus />} Save control total
      </Button>
    </details>
  );
}

function StepButtons({
  label,
  busy,
  pending,
  run,
  prefix,
}: {
  label: string;
  busy: string | null;
  pending: boolean;
  run: (step: string) => void;
  prefix: string;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {STEPS.map((s) => (
        <Button key={s} size="xs" variant="outline" disabled={pending} onClick={() => run(s)}>
          {pending && busy === `${prefix}${s}` ? <LoaderCircle className="animate-spin" /> : null}
          {s}
        </Button>
      ))}
    </div>
  );
}

function TestBlock({
  title,
  help,
  rows,
  action,
  line,
}: {
  title: string;
  help: string;
  rows: ValidationRow[];
  action: React.ReactNode;
  line: (r: ValidationRow) => string;
}) {
  return (
    <div className="space-y-2 rounded-xl bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 basis-72">
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{help}</p>
        </div>
        {action}
      </div>
      {rows.length ? (
        <ul className="divide-y divide-border text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="w-40 shrink-0 truncate font-medium">{r.subject}</span>
              <Verdict value={r.verdict} />
              <span className="min-w-0 flex-1 basis-60 text-xs text-muted-foreground">{line(r)}</span>
              <span className="text-xs text-muted-foreground">{when(r.created_at)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">Not run yet.</p>
      )}
    </div>
  );
}
