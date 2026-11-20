import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { consoleApi } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const time = (iso: string | null) =>
  iso ? new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit", second: "2-digit", timeZone: "America/Toronto" }).format(new Date(iso)) : "–";

function Pill({ value }: { value: string }) {
  const strong = ["failed", "partial", "running", "suppressed", "dropped", "warn", "fail"].includes(value);
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", strong ? "bg-brand text-brand-foreground" : "bg-surface-strong")}>{value}</span>;
}

/** Run inspector: the timeline of steps, every AI call with its exact prompt and answer, the
 *  signals and why each was kept or dropped, and every rejected card with its reasons. */
export default async function RunPage({ params }: { params: Promise<{ id: string; runId: string }> }) {
  const { id, runId } = await params;
  const d = await consoleApi.run(id, runId);
  const r = d.run;
  const cost = d.calls.reduce((n, c) => n + (c.cost_usd ?? 0), 0);

  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <Link href={`/console/workspaces/${id}?tab=runs`} className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" /> Runs
        </Link>
        <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
          {r.type} run <Pill value={r.status} />
        </h1>
        <p className="text-sm text-muted-foreground">
          Data through {r.period_end} · {time(r.started_at)} → {time(r.ended_at)} · warehouse {r.query_seconds.toFixed(2)} s ·{" "}
          {r.llm_tokens.toLocaleString("en-CA")} AI tokens (≈ US${cost.toFixed(4)}) · n8n execution {r.n8n_execution_id ?? "–"}
        </p>
        {r.error && <p className="rounded-lg bg-brand/10 px-3 py-2 text-sm text-brand">{r.error}</p>}
      </header>

      <section className="space-y-2">
        <h2 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
          Scorecard <Pill value={d.scorecard.verdict} />
          <span className="text-xs font-normal text-muted-foreground">
            {d.scorecard.numbers.cards} cards · {d.scorecard.numbers.signals} signals · {d.scorecard.numbers.dropped} dropped · {d.scorecard.numbers.rejections} rejected
          </span>
        </h2>
        <ul className="divide-y divide-border/70 rounded-xl bg-card shadow-card">
          {d.scorecard.checks.map((c) => (
            <li key={c.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
              <span className={cn("mt-0.5 inline-block size-2.5 shrink-0 rounded-full", c.status === "pass" ? "bg-foreground/30" : c.status === "warn" ? "bg-foreground/60" : "bg-brand")} aria-hidden />
              <span className="min-w-0 flex-1">
                <span className="font-medium">{c.title}</span>
                <span className="block text-xs text-muted-foreground">{c.detail}</span>
                {c.status !== "pass" && c.fix && <span className="block text-xs text-muted-foreground">What to do: {c.fix}</span>}
              </span>
              <Pill value={c.status} />
            </li>
          ))}
        </ul>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Steps ({d.steps.length})</h2>
        <ol className="relative space-y-2 border-l border-border pl-4">
          {d.steps.map((st, i) => (
            <li key={i} className="relative rounded-lg bg-card px-3 py-2 text-sm shadow-card">
              <span aria-hidden className={cn("absolute -left-[21px] top-3 size-2.5 rounded-full border-2 border-background", st.status === "failed" ? "bg-brand" : "bg-foreground/60")} />
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{st.role}</span>
                <span className="font-mono text-xs">{st.step}</span>
                <Pill value={st.status} />
                {st.attempts > 1 && <span className="text-xs text-muted-foreground">{st.attempts} tries</span>}
                <span className="ml-auto text-xs tabular-nums text-muted-foreground">{time(st.started_at)}</span>
              </div>
              {Object.keys(st.detail ?? {}).length > 0 && (
                <p className="mt-1 break-all font-mono text-[11px] text-muted-foreground">{JSON.stringify(st.detail)}</p>
              )}
            </li>
          ))}
        </ol>
      </section>

      <section className="space-y-2">
        <h2 className="text-sm font-semibold">AI calls ({d.calls.length})</h2>
        {d.calls.map((c, i) => (
          <details key={i} className="group rounded-xl bg-card shadow-card">
            <summary className="flex cursor-pointer list-none flex-wrap items-center gap-2 px-4 py-3 text-sm">
              <span className="inline-block transition-transform group-open:rotate-90">›</span>
              <span className="font-medium">{c.role}</span>
              <Pill value={c.status} />
              <span className="text-xs text-muted-foreground">{c.agent ?? "no agent"} · {c.provider}/{c.model}</span>
              <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                {c.input_tokens.toLocaleString("en-CA")} in · {c.output_tokens.toLocaleString("en-CA")} out · {(c.latency_ms / 1000).toFixed(1)} s
                {c.cost_usd !== null && ` · US$${c.cost_usd.toFixed(5)}`}
              </span>
            </summary>
            <div className="grid gap-3 border-t border-border/70 p-4 lg:grid-cols-2">
              {c.error && <p className="text-sm text-brand lg:col-span-2">{c.error}</p>}
              {[["System prompt", c.prompt.system], ["User prompt", c.prompt.user], ["Response", c.response ?? ""]].map(([label, text]) => (
                <div key={label} className={label === "Response" ? "lg:col-span-2" : ""}>
                  <p className="mb-1 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
                  <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-sidebar p-3 font-mono text-[11px] leading-relaxed text-sidebar-foreground">{text}</pre>
                </div>
              ))}
            </div>
          </details>
        ))}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Signals ({d.signals.length})</h2>
          <ul className="space-y-1.5">
            {d.signals.map((sig, i) => (
              <li key={i} className="flex flex-wrap items-center gap-2 rounded-lg bg-card px-3 py-2 text-xs shadow-card">
                <span className="font-medium">{sig.role}</span> · {sig.entity} · {sig.kind}
                {sig.zscore !== null && <span className="text-muted-foreground">z {sig.zscore.toFixed(1)}</span>}
                <span className="tabular-nums">{Math.round(sig.impact).toLocaleString("en-CA")} CAD</span>
                <span className="ml-auto"><Pill value={sig.status} /></span>
                {sig.reason && <span className="basis-full text-muted-foreground">{sig.reason}</span>}
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Rejected drafts ({d.rejections.length}) and stored cards ({d.cards.length})</h2>
          <ul className="space-y-1.5">
            {d.rejections.map((rj, i) => (
              <li key={`r${i}`} className="rounded-lg bg-brand/10 px-3 py-2 text-xs">
                <span className="font-medium">{rj.role}</span>: {rj.title}
                <p className="text-brand">{rj.reasons.join("; ")}</p>
              </li>
            ))}
            {d.cards.map((c, i) => (
              <li key={`c${i}`} className="rounded-lg bg-card px-3 py-2 text-xs shadow-card">
                <span className="font-medium">{c.role}</span>: {c.title} <Pill value={c.status} />
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
