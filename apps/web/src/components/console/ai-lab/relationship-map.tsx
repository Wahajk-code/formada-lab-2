"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- the profile is schema-checked JSON */

import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

type Family = "sales" | "purchasing" | "inventory" | "transfers" | "shared";

const FAMILY_OF = (t: string): Family =>
  /PURCHASE|VENDOR/.test(t) ? "purchasing" : /SALES|CASHSALE|INVOICE|FORECAST|CHANNEL/.test(t) ? "sales" : /INVENTORY/.test(t) ? "inventory" : /TRANSFER/.test(t) ? "transfers" : "shared";

const FAMILY: Record<Family, { label: string; color: string }> = {
  sales: { label: "Sales", color: "var(--iris)" },
  purchasing: { label: "Purchasing", color: "#f59e0b" },
  inventory: { label: "Inventory", color: "var(--jade)" },
  transfers: { label: "Transfers", color: "#0ea5e9" },
  shared: { label: "Shared lookups", color: "#a3a3a3" },
};

type Rel = { from: string; keys: string; to: string; refKeys: string };

/** "T ([\n \"A\"\n]) -> R ([...])" as the profile writes it. */
function parse(links: string[]): Rel[] {
  const out: Rel[] = [];
  for (const raw of links) {
    const m = raw.match(/^(\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\) -> (\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\)$/);
    if (m) out.push({ from: m[1], keys: m[2].replace(/["\s]+/g, " ").trim(), to: m[3], refKeys: m[4].replace(/["\s]+/g, " ").trim() });
  }
  return out;
}

const W = 232;
const H = 50;
const GAP = 12;

/** How the tables of a semantic view connect: one main table at a time in the middle with
 * everything it reaches around it, and a grid of every link at the bottom. */
export function RelationshipMap({ view }: { view: any }) {
  const rels = useMemo(() => parse(view.relationships ?? []), [view]);
  const tables: any[] = view.tables;
  const facts = tables.filter((t) => t.metrics.length).sort((a, b) => b.metrics.length - a.metrics.length);
  const plain = (t: string) => t.replace(/^DIM_/, "").replaceAll("_", " ").toLowerCase();
  const byName = Object.fromEntries(tables.map((t) => [t.table, t]));
  const [focus, setFocus] = useState<string>((facts.find((f) => f.table === "SALES_PLACED") ?? facts[0])?.table ?? "");
  const [hover, setHover] = useState<string | null>(null);
  if (!facts.length) return null;

  const mine = rels.filter((r) => r.from === focus);
  const reached = mine.map((r) => r.to).filter((t, i, a) => a.indexOf(t) === i);
  const left = reached.filter((_, i) => i % 2 === 0);
  const right = reached.filter((_, i) => i % 2 === 1);
  const rows = Math.max(left.length, right.length, 1);
  const height = rows * (H + GAP) + GAP;
  const cx = 10 + W + 56;
  const cw = W + 8;
  const x2 = cx + cw + 56;
  const pos: Record<string, { x: number; y: number }> = {};
  [left, right].forEach((col, c) => {
    const top = (height - col.length * (H + GAP) + GAP) / 2;
    col.forEach((t, i) => (pos[t] = { x: c === 0 ? 10 : x2, y: top + i * (H + GAP) }));
  });
  const fy = height / 2 - 28;
  const f = byName[focus];
  const fam = FAMILY[FAMILY_OF(focus)];
  const dim = (t: string) => hover !== null && hover !== t && hover !== focus;

  const dimsAll = tables.filter((t) => !t.metrics.length && rels.some((r) => r.to === t.table));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Main table">
        {facts.map((t) => (
          <button
            key={t.table}
            type="button"
            role="tab"
            aria-selected={focus === t.table}
            onClick={() => setFocus(t.table)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
              focus === t.table ? "bg-foreground text-background" : "bg-surface text-muted-foreground hover:text-foreground",
            )}
          >
            <span className="size-2 rounded-full" style={{ background: FAMILY[FAMILY_OF(t.table)].color }} aria-hidden />
            {t.table.replaceAll("_", " ").toLowerCase()}
          </button>
        ))}
      </div>

      <div className="overflow-x-auto rounded-2xl bg-surface/60 p-3">
        <svg viewBox={`0 0 ${x2 + W + 10} ${Math.max(height, 120)}`} className="h-auto w-full min-w-[760px]" role="img" aria-label={`${focus} and the tables it links to`}>
          {mine.map((r, i) => {
            const p = pos[r.to];
            if (!p) return null;
            const toLeft = p.x < cx;
            const xa = toLeft ? cx : cx + cw;
            const xb = toLeft ? p.x + W : p.x;
            const ya = fy + 28;
            const yb = p.y + H / 2;
            const mx = (xa + xb) / 2;
            return (
              <g key={i} opacity={dim(r.to) ? 0.18 : 1} className="transition-opacity">
                <path d={`M${xa},${ya} C${mx},${ya} ${mx},${yb} ${xb},${yb}`} fill="none" stroke={fam.color} strokeWidth={1.8} />
                <circle cx={xb} cy={yb} r={3.2} fill={fam.color} />
              </g>
            );
          })}
          <g transform={`translate(${cx},${fy})`}>
            <rect width={cw} height={56} rx={14} className="fill-foreground" />
            <rect x={0} y={0} width={5} height={56} rx={2.5} fill={fam.color} />
            <text x={18} y={22} className="fill-background text-[13px] font-semibold">{focus.replaceAll("_", " ").toLowerCase()}</text>
            <text x={18} y={39} className="fill-background/70 font-mono text-[9.5px]">{String(f?.base_table ?? "").replace("GOLD.", "").slice(0, 34)}</text>
            <text x={cw - 12} y={22} textAnchor="end" className="fill-background/80 text-[10px]">{f?.metrics.length} measures</text>
            <text x={cw - 12} y={39} textAnchor="end" className="fill-background/60 text-[10px]">{f?.dimension_count ?? f?.dimensions.length} fields</text>
          </g>
          {reached.map((t) => {
            const p = pos[t];
            const info = byName[t];
            const key = mine.find((r) => r.to === t);
            const kind = /SALES_ORDERS|CASHSALE|INVOICE/.test(t) ? "order document" : "reference";
            return (
              <g
                key={t}
                transform={`translate(${p.x},${p.y})`}
                onMouseEnter={() => setHover(t)}
                onMouseLeave={() => setHover(null)}
                opacity={dim(t) ? 0.35 : 1}
                className="cursor-default transition-opacity"
              >
                <rect width={W} height={H} rx={12} className="fill-card" stroke="rgba(0,0,0,0.08)" />
                <text x={12} y={19} className="fill-foreground text-[12px] font-semibold">{plain(t)}</text>
                <text x={W - 12} y={19} textAnchor="end" className="fill-muted-foreground text-[9.5px]">{kind}</text>
                <text x={12} y={34} className="fill-muted-foreground font-mono text-[9.5px]">{String(info?.base_table ?? "").split(".").pop()}</text>
                <text x={12} y={45} className="fill-muted-foreground font-mono text-[9px]">via {key?.keys.slice(0, 30)}</text>
              </g>
            );
          })}
        </svg>
        <p className="mt-2 text-[11px] text-muted-foreground">
          {f?.comment ? `${String(f.comment).split(". ")[0]}. ` : ""}<br />Reaches {reached.length} of {tables.length - 1} other tables. Hover a table to focus its link.
        </p>
      </div>

      <div className="overflow-x-auto rounded-2xl bg-surface/60 p-3">
        <p className="mb-2 text-xs font-semibold">Every link in the view</p>
        <table className="border-separate border-spacing-0 text-[11px]">
          <thead>
            <tr>
              <th className="sticky left-0 bg-surface/90 px-2 pb-2 text-left font-medium text-muted-foreground">main table ↓ reaches →</th>
              {dimsAll.map((d) => (
                <th key={d.table} className="px-0.5 pb-2 align-bottom font-normal text-muted-foreground">
                  <span className="block [writing-mode:vertical-rl] rotate-180 whitespace-nowrap">{d.table.replaceAll("_", " ").toLowerCase()}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {facts.map((t) => (
              <tr key={t.table} className={cn(focus === t.table && "bg-card")}>
                <th className="sticky left-0 whitespace-nowrap bg-surface/90 px-2 py-1 text-left font-medium">
                  <span className="mr-1.5 inline-block size-2 rounded-full" style={{ background: FAMILY[FAMILY_OF(t.table)].color }} aria-hidden />
                  {t.table.replaceAll("_", " ").toLowerCase()}
                </th>
                {dimsAll.map((d) => {
                  const r = rels.find((x) => x.from === t.table && x.to === d.table);
                  return (
                    <td key={d.table} className="px-0.5 py-1 text-center" title={r ? `${t.table}.${r.keys} → ${d.table}.${r.refKeys}` : undefined}>
                      {r ? <span className="inline-block size-3 rounded-full" style={{ background: FAMILY[FAMILY_OF(t.table)].color }} /> : <span className="inline-block size-1 rounded-full bg-border" />}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 flex flex-wrap gap-3 text-[11px] text-muted-foreground">
          {(Object.keys(FAMILY) as Family[]).filter((k) => k !== "shared").map((k) => (
            <span key={k} className="flex items-center gap-1">
              <span className="size-2 rounded-full" style={{ background: FAMILY[k].color }} /> {FAMILY[k].label}
            </span>
          ))}
        </p>
      </div>
    </div>
  );
}
