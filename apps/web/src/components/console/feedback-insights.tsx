import { Lightbulb } from "lucide-react";

import { BarList } from "@/components/charts/bar-list";
import type { FeedbackInsights } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);
const when = (iso: string) => new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric" }).format(new Date(iso));

/** What this workspace keeps rejecting (ADR 0025): per metric and role, per entity, per card
 *  writer, and the validator's reasons, with hints on where to act. */
export function FeedbackInsightsView({ data }: { data: FeedbackInsights }) {
  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold"><Lightbulb className="size-4 text-brand" /> Where to look</h2>
        {data.hints.length ? (
          <ul className="space-y-2">
            {data.hints.map((h, i) => (
              <li key={i} className="rounded-xl border border-brand/25 bg-brand/5 px-4 py-3 text-sm">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-brand">{h.kind === "agent" ? "Card writer" : "Metric"} · {h.target}</p>
                <p className="mt-0.5">{h.text}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl bg-surface px-4 py-3 text-sm text-muted-foreground">
            Nothing stands out in the last {data.since_days} days. Hints appear when a metric&apos;s Not relevant rate or a writer&apos;s rejection rate passes its threshold (Config & rules › Feedback loop).
          </p>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Card fate per role and metric · last {data.since_days} days</h2>
        <div className="-mx-1 overflow-x-auto">
          <table className="w-full min-w-[44rem] overflow-hidden rounded-xl bg-card text-sm shadow-card">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {["Role", "Metric", "Shown", "Open", "Actioned", "Not relevant", "Impossible", "Expired", "NR rate"].map((h) => (
                  <th key={h} className="px-3 py-2 font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.metrics.map((m) => (
                <tr key={`${m.role}-${m.metric}`} className="border-t border-border/70">
                  <td className="px-3 py-2">{m.role}</td>
                  <td className="px-3 py-2">{m.metric}</td>
                  {[m.shown, m.open, m.actioned, m.not_relevant, m.impossible, m.expired].map((v, i) => (
                    <td key={i} className="px-3 py-2 tabular-nums">{v}</td>
                  ))}
                  <td className={cn("px-3 py-2 tabular-nums", (m.not_relevant_rate ?? 0) >= 0.5 && "font-semibold text-brand")}>{pct(m.not_relevant_rate)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-3 rounded-2xl bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold">Most rejected entities</h2>
          <BarList
            empty="No feedback yet."
            bars={data.entities.map((e) => ({
              key: `${e.role}-${e.entity}-${e.type}`,
              label: e.entity,
              value: e.count,
              display: String(e.count),
              sub: `${e.role} · ${e.type.replace("_", " ")}`,
            }))}
          />
        </section>
        <section className="space-y-3 rounded-2xl bg-surface p-4 shadow-card">
          <h2 className="text-sm font-semibold">Drafts the validator refused, by reason</h2>
          <BarList
            empty="No refused drafts."
            bars={data.rejections.map((r) => ({
              key: `${r.role}-${r.category}`,
              label: r.category,
              value: r.count,
              display: String(r.count),
              sub: r.role,
            }))}
          />
        </section>
      </div>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Card writers in this workspace</h2>
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {data.writers.map((w) => (
            <div key={w.agent} className="rounded-xl bg-card p-3 shadow-card">
              <p className="font-mono text-xs">{w.agent}</p>
              <p className="mt-1 text-sm">
                <span className="font-semibold tabular-nums">{pct(w.rejection_rate)}</span> refused · {w.rejected} of {w.written} drafts
              </p>
              {w.top_reason && <p className="text-xs text-muted-foreground">mostly {w.top_reason}</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Latest feedback</h2>
        <ul className="space-y-1.5">
          {data.recent.map((f, i) => (
            <li key={i} className="rounded-lg bg-card px-3 py-2 text-xs shadow-card">
              <span className="font-medium">{f.card}</span>
              <p className="text-muted-foreground">
                {f.type.replace("_", " ")} by {f.by} ({f.role}) · {when(f.at)}
                {f.reason && <> · “{f.reason}”</>}
              </p>
            </li>
          ))}
          {data.recent.length === 0 && <li className="text-sm text-muted-foreground">No feedback in this period.</li>}
        </ul>
      </section>
    </div>
  );
}
