"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { ArrowRight, ChevronDown, LoaderCircle, RotateCcw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { recheckMapping } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import { confidenceTone, DOT, fillTone, Pill, STROKE, TONE } from "@/components/onboarding/tone";
import type { OnboardingGuide, OnboardingStep } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const num = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-CA"));
export const WORDS: Record<string, string> = {
  inventory_snapshot: "Stock by item and location, per day",
  inventory_position: "Current stock per item",
  sales_line: "Sales lines",
  purchase_order: "Purchase orders",
  purchase_order_line: "Purchase order lines",
  wholesale_order_line: "Wholesale order lines",
};

export function FieldFlow({ a, fills, meanings }: { a: any; fills: Record<string, number>; meanings: Record<string, string> }) {
  return (
    <div className="overflow-x-auto rounded-xl bg-surface p-3">
      <div className="grid min-w-[640px] grid-cols-[minmax(0,1fr)_88px_minmax(0,1fr)_120px] items-center gap-x-2 gap-y-1.5 text-xs">
        <p className="font-semibold text-muted-foreground">Their columns</p>
        <span />
        <p className="font-semibold text-muted-foreground">Our field</p>
        <p className="text-right font-semibold text-muted-foreground">Filled in test</p>
        {a.fields.map((f: any) => {
          const tone = f.source_columns.length ? confidenceTone(f.confidence) : "missing";
          const fill = fills[f.field];
          return (
            <div key={f.field} className="contents" title={f.reason}>
              <span className="min-w-0 truncate font-mono">
                {f.source_columns.length ? f.source_columns.map((c: string) => c.split(".").slice(-1)[0]).join(" + ") : <span className="text-[var(--critical-ink)]">not in their data</span>}
              </span>
              <svg viewBox="0 0 88 12" className="h-3 w-[88px]" aria-hidden>
                <line x1="2" y1="6" x2="80" y2="6" stroke={STROKE[tone]} strokeWidth="2" strokeDasharray={tone === "missing" ? "4 3" : undefined} />
                <path d="M78,2 L86,6 L78,10" fill="none" stroke={STROKE[tone]} strokeWidth="2" />
              </svg>
              <span className="min-w-0">
                <span className={cn("rounded px-1.5 py-0.5 font-mono", TONE[tone])}>{f.field}</span>
                {meanings[f.field] && <span className="ml-1.5 text-[10px] text-muted-foreground">{meanings[f.field].slice(0, 60)}</span>}
              </span>
              <span className="flex items-center justify-end gap-1.5">
                <span className="h-1.5 w-14 overflow-hidden rounded-full bg-surface-strong">
                  <span className={cn("block h-full", DOT[fillTone(fill)])} style={{ width: `${fill ?? 0}%` }} />
                </span>
                <span className="w-10 text-right tabular-nums">{fill == null ? "–" : `${fill}%`}</span>
              </span>
            </div>
          );
        })}
      </div>
      <p className="mt-3 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className={cn("h-0.5 w-4", DOT.matched)} /> matched, high confidence</span>
        <span className="flex items-center gap-1"><span className={cn("h-0.5 w-4", DOT.partial)} /> medium</span>
        <span className="flex items-center gap-1"><span className={cn("h-0.5 w-4", DOT.missing)} /> low or missing</span>
      </p>
    </div>
  );
}

function ShapeCard({ a, check, meta, sql, setSql }: { a: any; check: any; meta: OnboardingGuide["archetypes"][number] | undefined; sql: string; setSql: (v: string) => void }) {
  const [showSql, setShowSql] = useState(false);
  const fills = Object.fromEntries((check.fills ?? []).map((x: any) => [x.field, x.fill_pct]));
  const meanings = Object.fromEntries((meta?.fields ?? []).map((f) => [f.field, f.meaning]));
  const unmappable = a.status === "unmappable";
  const tone = unmappable ? "neutral" : check.ok ? "good" : "missing";
  return (
    <div className="space-y-4 rounded-2xl bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <p className="text-base font-semibold">{WORDS[a.archetype] ?? a.archetype}</p>
          <p className="font-mono text-[11px] text-muted-foreground">{a.archetype}</p>
          {meta && <p className="text-sm text-muted-foreground">{meta.description}</p>}
        </div>
        <Pill tone={tone}>{unmappable ? "not in their data" : check.ok ? "passes the live test" : "fails the live test"}</Pill>
      </div>
      {unmappable ? (
        <p className="text-sm text-muted-foreground">{a.questions?.[0] ?? "Their warehouse has no source for this. Cards that need it are not turned on."}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-xs">
            <Pill tone={check.rows ? "matched" : "missing"}>{num(check.rows)} rows</Pill>
            {check.first_date && <Pill tone="neutral">{check.first_date} → {check.last_date}</Pill>}
            {check.dates != null && <Pill tone="neutral">{num(check.dates)} dates</Pill>}
          </div>
          {(check.errors ?? []).map((e: string) => (
            <p key={e} className={cn("rounded-lg px-3 py-2 text-xs", TONE.missing)}>{e}</p>
          ))}
          {(check.warnings ?? []).map((w: string) => (
            <p key={w} className={cn("rounded-lg px-3 py-2 text-xs", TONE.partial)}>{w}</p>
          ))}
          <FieldFlow a={a} fills={fills} meanings={meanings} />
          {a.filters.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-semibold">Rules applied to their rows</p>
              <ul className="list-disc space-y-0.5 pl-5 text-sm">
                {a.filters.map((f: string, idx: number) => <li key={idx}>{f}</li>)}
              </ul>
            </div>
          )}
          {check.value_mix &&
            Object.entries(check.value_mix).map(([field, vals]: [string, any]) => {
              const total = vals.reduce((s: number, v: any) => s + (v.rows ?? 0), 0) || 1;
              return (
                <div key={field} className="space-y-1">
                  <p className="text-xs font-semibold">
                    How rows split by <span className="font-mono">{field}</span>
                  </p>
                  <div className="flex h-3 overflow-hidden rounded-full">
                    {vals.map((v: any, i: number) => (
                      <span key={String(v.value)} title={`${v.value ?? "NULL"}: ${num(v.rows)}`} className={cn("h-full", ["bg-[var(--iris)]", "bg-[var(--jade)]", "bg-[var(--attention-ink)]", "bg-[var(--critical-ink)]", "bg-[var(--fd-secondary)]"][i % 5])} style={{ width: `${(100 * v.rows) / total}%` }} />
                    ))}
                  </div>
                  <p className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                    {vals.map((v: any, i: number) => (
                      <span key={String(v.value)} className="flex items-center gap-1">
                        <span className={cn("size-2 rounded-full", ["bg-[var(--iris)]", "bg-[var(--jade)]", "bg-[var(--attention-ink)]", "bg-[var(--critical-ink)]", "bg-[var(--fd-secondary)]"][i % 5])} />
                        {v.value ?? "NULL"} {num(v.rows)}
                      </span>
                    ))}
                  </p>
                </div>
              );
            })}
          {a.questions?.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-muted-foreground">
              {a.questions.map((q: string, idx: number) => <li key={idx}>{q}</li>)}
            </ul>
          )}
          <button type="button" onClick={() => setShowSql(!showSql)} className="flex items-center gap-1 text-xs font-medium">
            <ChevronDown className={cn("size-3.5 transition-transform", showSql && "rotate-180")} /> The query (read-only on their warehouse)
          </button>
          {showSql && (
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              spellCheck={false}
              rows={Math.min(20, sql.split("\n").length + 1)}
              className="w-full rounded-lg bg-surface p-3 font-mono text-[11px] leading-relaxed shadow-inner outline-none focus:ring-2 focus:ring-ring/40"
            />
          )}
        </>
      )}
    </div>
  );
}

/** Mapping: understand every link first; edit and re-check; approve at the bottom. */
export function MappingGuide({ step, guide, workspaceId, can }: { step: OnboardingStep; guide: OnboardingGuide | null; workspaceId: string; can: boolean }) {
  const router = useRouter();
  const out = step.output as any;
  const checks = (step.checks?.archetypes ?? {}) as Record<string, any>;
  const metas = Object.fromEntries((guide?.archetypes ?? []).map((a) => [a.archetype, a]));
  const [sql, setSql] = useState<Record<string, string>>(() => Object.fromEntries(out.archetypes.map((a: any) => [a.archetype, a.source_sql])));
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const edited = out.archetypes.filter((a: any) => sql[a.archetype] !== a.source_sql);
  const linked = out.archetypes.filter((a: any) => a.status !== "unmappable");
  const passing = linked.filter((a: any) => checks[a.archetype]?.ok).length;
  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm leading-relaxed">
          Their tables are linked to our standard shapes so the same tested calculations work for every client. Each link is a read-only query run live on their
          warehouse: <b>{passing}</b> of {linked.length} pass, {out.archetypes.length - linked.length} have no source in their data.
        </p>
        <div className="flex flex-wrap gap-2">
          {out.archetypes.map((a: any) => {
            const c = checks[a.archetype] ?? {};
            const tone = a.status === "unmappable" ? "neutral" : c.ok ? "good" : "missing";
            return (
              <Pill key={a.archetype} tone={tone}>
                {WORDS[a.archetype] ?? a.archetype}
                {a.status !== "unmappable" && <span className="opacity-70"> · {num(c.rows)}</span>}
              </Pill>
            );
          })}
        </div>
      </div>

      {[...linked, ...out.archetypes.filter((a: any) => a.status === "unmappable")].map((a: any) => (
        <ShapeCard key={a.archetype} a={a} check={checks[a.archetype] ?? {}} meta={metas[a.archetype]} sql={sql[a.archetype] ?? ""} setSql={(v) => setSql({ ...sql, [a.archetype]: v })} />
      ))}

      <div className={cn("space-y-2 rounded-2xl p-4 text-sm", TONE.matched)}>
        <p className="font-semibold">How to edit a link</p>
        <ol className="list-decimal space-y-1 pl-5 text-xs leading-relaxed">
          <li>Small fix (a filter, a code list, a column): open &ldquo;The query&rdquo;, edit it, then click <b>Re-check edited links</b>. Code runs it again on their warehouse and shows new results as a new proposal.</li>
          <li>Bigger change or a client answer: click <b>Run the analysis again</b> below with a note, for example &ldquo;Overstock is sellable warehouse stock&rdquo;.</li>
          <li>Approve keeps the links that pass and skips any that fail. Only passing links are used by the calculations.</li>
        </ol>
        {edited.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button
              size="sm"
              disabled={!can || pending}
              onClick={() =>
                start(async () => {
                  const res = await recheckMapping(workspaceId, step.id, edited.map((a: any) => ({ archetype: a.archetype, source_sql: sql[a.archetype] })));
                  setMsg(res.ok ? "Re-checked as a new proposal." : res.error);
                  router.refresh();
                })
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <RotateCcw />} Re-check {edited.length} edited link{edited.length > 1 ? "s" : ""}
            </Button>
            {msg && <span className="text-xs">{msg}</span>}
          </div>
        )}
      </div>
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        Review done? Approve below <ArrowRight className="size-3.5" />
      </p>
    </div>
  );
}
