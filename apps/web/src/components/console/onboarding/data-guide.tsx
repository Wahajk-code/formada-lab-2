"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { ChevronDown, Database, Send, Check } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { askClient } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import {
  confidenceTone,
  coverageTone,
  DOT,
  fillTone,
  Pill,
  severityTone,
  STROKE,
  TONE,
} from "@/components/onboarding/tone";
import type { OnboardingGuide } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const num = (v: number | null | undefined) => (v == null ? "–" : v.toLocaleString("en-CA"));
const short = (t: string) => t.split(".").pop() ?? t;

/** Break a long table name into lines that fit an SVG card, after underscores. */
function wrapName(name: string, perLine = 24): string[] {
  const lines: string[] = [];
  let cur = "";
  for (const token of name.split(/(?<=_)/)) {
    const rest = token;
    if (rest.length > perLine) {
      // One very long word: split it into even parts, not a full line and a stub.
      if (cur) lines.push(cur);
      cur = "";
      const parts = Math.ceil(rest.length / perLine);
      const size = Math.ceil(rest.length / parts);
      for (let i = 0; i < rest.length; i += size) lines.push(rest.slice(i, i + size));
      continue;
    }
    if (cur && (cur + rest).length > perLine) {
      lines.push(cur);
      cur = rest;
    } else cur += rest;
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [name];
}

// ---------------------------------------------------------------------------------------------
// Relationship diagram: facts in the middle, other tables on both sides, joins as curves
// ---------------------------------------------------------------------------------------------

export function ErDiagram({ tables, rows }: { tables: any[]; rows: Record<string, number | null> }) {
  const W = 250,
    HEAD = 30,
    LINE = 16,
    GAP_Y = 22,
    COL_X = [10, 360, 710];
  const boxH = (t: any) => HEAD + LINE + Math.min(t.key_columns.length, 4) * LINE + 12 + (wrapName(short(t.table)).length - 1) * 14;
  const facts = tables.filter((t) => t.kind === "fact");
  const others = tables.filter((t) => t.kind !== "fact");
  const cols: any[][] = [[], facts, []];
  others.forEach((t, i) => cols[i % 2 === 0 ? 0 : 2].push(t));
  const pos: Record<string, { x: number; y: number; h: number; col: number }> = {};
  let height = 0;
  cols.forEach((list, c) => {
    const total = list.reduce((s, t) => s + boxH(t) + GAP_Y, 0);
    let y = 10;
    list.forEach((t) => {
      pos[t.table] = { x: COL_X[c], y, h: boxH(t), col: c };
      y += boxH(t) + GAP_Y;
    });
    height = Math.max(height, total + 10);
  });
  const edges: { d: string; tone: keyof typeof STROKE; label: string }[] = [];
  for (const t of tables) {
    for (const j of t.joins ?? []) {
      const a = pos[t.table],
        b = pos[j.references_table] ?? pos[Object.keys(pos).find((k) => short(k) === short(j.references_table)) ?? ""];
      if (!a || !b || a === b) continue;
      const fromRight = a.col <= b.col;
      const x1 = fromRight ? a.x + W : a.x,
        x2 = fromRight ? b.x : b.x + W;
      const y1 = a.y + a.h / 2,
        y2 = b.y + b.h / 2,
        mx = (x1 + x2) / 2;
      edges.push({ d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, tone: confidenceTone(j.confidence), label: j.column });
    }
  }
  return (
    <div className="overflow-x-auto rounded-2xl bg-surface/60 p-3">
      <svg viewBox={`0 0 ${COL_X[2] + W + 10} ${Math.max(height, 80)}`} className="h-auto w-full min-w-[720px]" role="img" aria-label="Tables and how they join">
        {edges.map((e, i) => (
          <g key={i}>
            <path d={e.d} fill="none" stroke={STROKE[e.tone]} strokeWidth={1.8} strokeDasharray={e.tone === "missing" ? "4 3" : undefined} />
          </g>
        ))}
        {tables.map((t) => {
          const p = pos[t.table];
          if (!p) return null;
          return (
            <g key={t.table} transform={`translate(${p.x},${p.y})`}>
              <rect width={W} height={p.h} rx={12} className={t.kind === "fact" ? "fill-foreground" : "fill-card"} stroke="rgba(0,0,0,0.08)" />
              <title>{t.table}</title>
              <text x={12} y={19} className={cn("text-[12px] font-semibold", t.kind === "fact" ? "fill-background" : "fill-foreground")}>
                {wrapName(short(t.table)).map((line, li) => (
                  <tspan key={line} x={12} dy={li === 0 ? 0 : 14}>
                    {line}
                  </tspan>
                ))}
              </text>
              <text x={12} y={HEAD + 8 + (wrapName(short(t.table)).length - 1) * 14} className={cn("text-[10px]", t.kind === "fact" ? "fill-background/70" : "fill-muted-foreground")}>
                {t.kind} · {num(rows[t.table])}
              </text>
              {t.key_columns.slice(0, 4).map((c: string, i: number) => (
                <text key={c} x={12} y={HEAD + 12 + (i + 1) * LINE + (wrapName(short(t.table)).length - 1) * 14} className={cn("font-mono text-[10px]", t.kind === "fact" ? "fill-background/80" : "fill-muted-foreground")}>
                  {c.slice(0, 32)}
                </text>
              ))}
            </g>
          );
        })}
      </svg>
      <p className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
        <span className="flex items-center gap-1"><span className="size-2 rounded-full bg-foreground" /> main (fact) table</span>
        <span className="flex items-center gap-1"><span className={cn("h-0.5 w-4", DOT.matched)} /> join, high confidence</span>
        <span className="flex items-center gap-1"><span className={cn("h-0.5 w-4", DOT.partial)} /> medium</span>
        <span className="flex items-center gap-1"><span className={cn("h-0.5 w-4", DOT.missing)} /> low</span>
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The data guide
// ---------------------------------------------------------------------------------------------

function TableCard({ t, profile }: { t: any; profile: OnboardingGuide["profile"]["tables"][number] | undefined }) {
  const [open, setOpen] = useState(t.kind === "fact");
  const cols = profile?.columns ?? [];
  const keys = new Set(t.key_columns.map((c: string) => short(c).toUpperCase()));
  return (
    <div className="rounded-xl bg-card shadow-card">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-start gap-3 p-3 text-left">
        <Database className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="font-mono text-sm font-semibold">{t.table}</p>
          <p className="text-xs text-muted-foreground">
            {t.kind} · one row is {t.grain} · {num(profile?.rows)} rows · {cols.length} fields
          </p>
          <p className="mt-1 text-sm">{t.purpose}</p>
        </div>
        <ChevronDown className={cn("mt-1 size-4 transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="space-y-3 border-t border-border/60 p-3">
          {t.joins.length > 0 && (
            <div className="flex flex-wrap gap-1.5 text-xs">
              {t.joins.map((j: any) => (
                <Pill key={j.column + j.references_table} tone={confidenceTone(j.confidence)}>
                  {j.column} → {short(j.references_table)}.{j.references_column}
                </Pill>
              ))}
            </div>
          )}
          {cols.length > 0 && (
            <div className="max-h-80 overflow-auto rounded-lg bg-surface">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface text-left text-muted-foreground">
                  <tr>
                    <th className="p-2 font-medium">Field</th>
                    <th className="p-2 font-medium">Type</th>
                    <th className="p-2 font-medium">Filled</th>
                    <th className="p-2 text-right font-medium">Distinct</th>
                  </tr>
                </thead>
                <tbody>
                  {cols.map((c) => (
                    <tr key={c.column} className="border-t border-border/40">
                      <td className="p-2 font-mono">
                        {c.column}
                        {keys.has(c.column.toUpperCase()) && <span className="ml-1 rounded bg-foreground px-1 text-[9px] text-background">key</span>}
                      </td>
                      <td className="p-2 text-muted-foreground">{c.type}</td>
                      <td className="p-2">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-surface-strong">
                            <span className={cn("block h-full", DOT[fillTone(c.fill_pct)])} style={{ width: `${c.fill_pct ?? 0}%` }} />
                          </span>
                          <span className="tabular-nums">{c.fill_pct == null ? "–" : `${c.fill_pct}%`}</span>
                        </span>
                      </td>
                      <td className="p-2 text-right tabular-nums">{num(c.distinct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SuggestedQuestions({ questions, workspaceId, can }: { questions: any[]; workspaceId: string; can: boolean }) {
  const router = useRouter();
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [pending, start] = useTransition();
  return (
    <ul className="space-y-1.5">
      {questions.map((q: any, idx: number) => (
        <li key={idx} className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2 text-sm">
          <span className="min-w-0 flex-1">
            {q.question}
            <span className="block text-[11px] text-muted-foreground">
              for {q.to} · {q.why}
            </span>
          </span>
          {q.to === "client" && (
            <Button
              size="xs"
              variant="outline"
              disabled={!can || pending || sent.has(q.question)}
              onClick={() =>
                start(async () => {
                  const res = await askClient(workspaceId, "discovery", q.question.slice(0, 120), `${q.question}\n\nWhy we ask: ${q.why}`);
                  if (res.ok) setSent(new Set([...sent, q.question]));
                  router.refresh();
                })
              }
            >
              {sent.has(q.question) ? <Check /> : <Send />} {sent.has(q.question) ? "Sent" : "Send to client"}
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}

function H({ children, note }: { children: React.ReactNode; note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-2">
      <h4 className="text-sm font-semibold">{children}</h4>
      {note && <span className="text-xs text-muted-foreground">{note}</span>}
    </div>
  );
}

/** Discovery: the full data guide (tables, fields, joins, coverage, issues, questions). */
export function DataGuide({ out, guide, workspaceId, can, showSummary = true }: { out: any; guide: OnboardingGuide | null; workspaceId: string; can: boolean; showSummary?: boolean }) {
  const profiles = Object.fromEntries((guide?.profile.tables ?? []).map((t) => [t.table, t]));
  const rows = Object.fromEntries((guide?.profile.tables ?? []).map((t) => [t.table, t.rows]));
  const cov = (s: string) => out.coverage.filter((c: any) => c.status === s).length;
  const order = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  const issues = [...out.quality_issues].sort((a: any, b: any) => order[a.severity] - order[b.severity]);
  return (
    <div className="space-y-6">
      <div className="space-y-2">
        {showSummary && <p className="leading-relaxed">{out.summary}</p>}
        <p className="text-sm text-muted-foreground">
          <b className="text-foreground">How often it is counted: </b>
          {out.cadence}
        </p>
        <div className="flex flex-wrap gap-2 pt-1 text-xs">
          <Pill tone="good">{cov("present")} areas present</Pill>
          <Pill tone="partial">{cov("partial")} partial</Pill>
          <Pill tone="missing">{cov("missing")} missing</Pill>
          <Pill tone="missing">{issues.filter((q: any) => q.severity === "high").length} high issues</Pill>
          <Pill tone="neutral">{out.tables.length} tables</Pill>
        </div>
      </div>

      <div className="space-y-2">
        <H note="green present · amber partial · red missing">Areas covered against our standard model</H>
        <div className="grid gap-2 sm:grid-cols-3">
          {out.coverage.map((c: any) => (
            <div key={c.family} className={cn("rounded-xl p-3 text-xs", TONE[coverageTone(c.status)])}>
              <p className="text-sm font-semibold capitalize">
                {c.family.replaceAll("_", " ")} · {c.status}
              </p>
              <p className="mt-1 leading-relaxed opacity-90">{c.evidence}</p>
            </div>
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <H note="what each table is and how they join">Tables and relationships</H>
        <ErDiagram tables={out.tables} rows={rows} />
      </div>

      <div className="space-y-2">
        <H note="click a table for every field, its type and how complete it is">Tables and fields</H>
        <div className="space-y-2">
          {out.tables.map((t: any) => (
            <TableCard key={t.table} t={t} profile={profiles[t.table]} />
          ))}
        </div>
      </div>

      <div className="space-y-2">
        <H note="red high · amber medium · grey low">Issues in the data</H>
        <ul className="space-y-2">
          {issues.map((q: any, idx: number) => (
            <li key={idx} className={cn("rounded-xl p-3 text-sm", TONE[severityTone(q.severity)])}>
              <p className="font-semibold">
                {q.severity.toUpperCase()} · {q.title}
              </p>
              <p className="mt-1 text-xs opacity-90">{q.evidence}</p>
              <p className="mt-1 text-xs">
                <b>Impact: </b>
                {q.impact}
              </p>
              <p className="text-xs">
                <b>How we handle it: </b>
                {q.suggested_handling}
              </p>
              {q.columns?.length > 0 && <p className="mt-1 font-mono text-[10px] opacity-75">{q.columns.join(", ")}</p>}
            </li>
          ))}
        </ul>
      </div>

      {out.questions.length > 0 && (
        <div className="space-y-2">
          <H note="send the ones for the client to them in one click">Open questions</H>
          <SuggestedQuestions questions={out.questions} workspaceId={workspaceId} can={can} />
        </div>
      )}
    </div>
  );
}
