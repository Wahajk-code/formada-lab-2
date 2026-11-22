"use client";

/**
 * The building blocks of every review in the console (docs/review-format.md): one status
 * vocabulary, sections that say their point, labelled lines instead of run-on sentences, human
 * names over technical ones, readable dates and counts, and the same tools on every item.
 */

import { useState } from "react";

import type { CardCtx } from "@/components/console/onboarding/card-tools";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

// ---- numbers, dates and names a person can read ------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const exact = new Intl.NumberFormat("en-CA");
const compact = new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 });

export const fmt = {
  /** 2026-11-13 -> 13 Nov 2026 */
  date(iso?: string | null): string {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
    return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : (iso ?? "–");
  },
  /** 2026-11-13 -> Nov 2026 */
  month(iso?: string | null): string {
    const m = /^(\d{4})-(\d{2})/.exec(iso ?? "");
    return m ? `${MONTHS[Number(m[2]) - 1]} ${m[1]}` : (iso ?? "–");
  },
  /** Two dates as one short range: 13 Oct → 13 Nov 2026, Dec 2024 → Nov 2026. */
  range(from?: string | null, to?: string | null, byMonth = false): string {
    if (!from || !to) return fmt.date(from ?? to);
    if (byMonth) return `${fmt.month(from)} → ${fmt.month(to)}`;
    const a = fmt.date(from);
    const b = fmt.date(to);
    return from.slice(0, 4) === to.slice(0, 4) ? `${a.replace(/ \d{4}$/, "")} → ${b}` : `${a} → ${b}`;
  },
  /** 3428183 -> 3.4M; small numbers stay exact. */
  count(n?: number | null): string {
    return n == null ? "–" : n < 10_000 ? exact.format(n) : compact.format(n);
  },
  exact(n?: number | null): string {
    return n == null ? "–" : exact.format(n);
  },
  pct(part: number, whole: number): string {
    if (!whole) return "–";
    const p = (100 * part) / whole;
    return p > 0 && p < 1 ? "<1%" : `${Math.round(p)}%`;
  },
  plural(n: number, one: string, many = `${one}s`): string {
    return `${exact.format(n)} ${n === 1 ? one : many}`;
  },
  days(n: number): string {
    return n === 1 ? "daily" : n === 7 ? "weekly" : n === 14 ? "every 2 weeks" : `every ${n} days`;
  },
};

/** Older guides say a view's facts were "named in the view, not measured". With semantic views as
 * the only source that is understood and says nothing, so it is not shown (the stored text stays). */
const UNMEASURED = /,?\s*(?:is |are )?named in (?:the |their |this )?(?:[\w' ]{0,25}?)views?,?\s*not measured\.?/gi;
/** A caveat that only says a fact table was not measured: nothing to show. */
export const isUnmeasuredNote = (line: string) => /^\s*[\w.]+:?\s*(?:is |are )?named in (?:the |their |this )?(?:[\w' ]{0,25}?)views?,?\s*not measured\.?\s*$/i.test(line);

/** Show ISO dates inside AI text the way people read them, and leave out the "not measured" boilerplate. The stored text is not changed. */
export const humanDates = (text?: string | null) =>
  String(text ?? "")
    .replace(UNMEASURED, " in the view.")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (d) => fmt.date(d));

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** SCHEMA.DIM_RETAIL_GROUP -> Retail group; SALES_INVOICED -> Sales invoiced. */
export function humanName(technical: string): string {
  const last = technical.split(".").pop() ?? technical;
  const words = last
    .replace(/^(DIM|FACT|GOLD|STG|SV|VW|V)_/i, "")
    .replace(/^(NETSUITE|SHOPIFY)_/i, "")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
  return cap(words || last.toLowerCase());
}
export const shortName = (t: string) => t.split(".").pop() ?? t;

/** A namer that prefers the customer's own name for a table (from their semantic views), so
 * GOLD_NETSUITE_AGGREGATEITEMLOCATION reads "Inventory item locations". */
export function makeNamer(views: { tables: { table: string; base_table: string | null }[] }[] | undefined): (technical: string) => string {
  const byBase = new Map<string, string>();
  for (const v of views ?? []) for (const t of v.tables) if (t.base_table && !byBase.has(shortName(t.base_table).toUpperCase())) byBase.set(shortName(t.base_table).toUpperCase(), humanName(t.table));
  return (technical: string) => byBase.get(shortName(technical).toUpperCase()) ?? humanName(technical);
}

// ---- status: one vocabulary everywhere ---------------------------------------------------------

export type Tone = "ready" | "partial" | "missing" | "decide" | "fail" | "info";
const TONE_ICON: Record<Tone, IconName> = { ready: "check", partial: "danger-circle", missing: "minus", decide: "circle-help", fail: "x", info: "info" };

export function Status({ tone, children, title }: { tone: Tone; children: React.ReactNode; title?: string }) {
  return (
    <span className={cn("rv-status", `rv-${tone}`)} title={title}>
      <Icon name={TONE_ICON[tone]} size={12} />
      {children}
    </span>
  );
}

/** Coverage words: present / partial / missing. */
export const COVERAGE: Record<string, { tone: Tone; word: string }> = {
  present: { tone: "ready", word: "Ready" },
  partial: { tone: "partial", word: "Partly there" },
  missing: { tone: "missing", word: "Not found" },
};

export function Severity({ level }: { level: string }) {
  const l = (["high", "medium", "low"].includes(level) ? level : "low") as "high" | "medium" | "low";
  return (
    <span className={cn("rv-sev", `rv-sev-${l}`)}>
      <i aria-hidden />
      {cap(l)}
    </span>
  );
}

// ---- layout -------------------------------------------------------------------------------------

/** A section: a title, the one line that says what it is for, and its block tools on the right. */
export function Section({
  id,
  icon,
  title,
  point,
  count,
  tools,
  children,
  className,
}: {
  id?: string;
  icon?: IconName;
  title: string;
  point?: string;
  count?: React.ReactNode;
  tools?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section id={id} className={cn("rv-section", className)} aria-labelledby={id ? `${id}-title` : undefined}>
      <header className={cn("rv-section-head", tools && "card-hover")}>
        {icon && (
          <span className="rv-section-icon" aria-hidden>
            <Icon name={icon} size={17} />
          </span>
        )}
        <div className="rv-section-text">
          <h5 id={id ? `${id}-title` : undefined}>
            {title}
            {count != null && <small>{count}</small>}
          </h5>
          {point && <p>{point}</p>}
        </div>
        {tools}
      </header>
      {children}
    </section>
  );
}

/** A small heading inside a section, with the tools of its block. */
export function Sub({ title, note, tools }: { title: string; note?: React.ReactNode; tools?: React.ReactNode }) {
  return (
    <div className={cn("rv-sub", tools && "card-hover")}>
      <h6>
        {title}
        {note != null && <small>{note}</small>}
      </h6>
      {tools}
    </div>
  );
}

/** Labelled lines: the same short labels in the same place on every item. */
export function Lines({ rows }: { rows: [string, React.ReactNode][] }) {
  const shown = rows.filter(([, v]) => v != null && v !== "" && v !== false);
  return (
    <dl className="rv-lines">
      {shown.map(([label, value]) => (
        <div key={label}>
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Long technical names break after a dot or an underscore, never inside a word. */
export function breakable(name: string): React.ReactNode {
  return name.split(/(?<=[._])/).map((part, i) => (
    <span key={i}>
      {part}
      <wbr />
    </span>
  ));
}

/** A human name with the technical one under it. */
export function Name({ technical, human, sub }: { technical: string; human?: string; sub?: React.ReactNode }) {
  return (
    <span className="rv-name">
      <b>{human ?? humanName(technical)}</b>
      <code>{breakable(technical)}</code>
      {sub}
    </span>
  );
}

/** Folded detail: one click away, never in the way. */
export function Fold({ title, note, children, open, icon = "chevron-down" }: { title: string; note?: string; children: React.ReactNode; open?: boolean; icon?: IconName }) {
  return (
    <details className="rv-fold" open={open}>
      <summary>
        <strong>{title}</strong>
        {note && <small>{note}</small>}
        <Icon name={icon} size={15} />
      </summary>
      <div className="rv-fold-body">{children}</div>
    </details>
  );
}

/** A share of rows as one stacked bar with a legend: value, count and percentage. */
export function SplitBar({ values, label }: { values: { value: string; rows: number }[]; label: string }) {
  const total = values.reduce((n, v) => n + v.rows, 0) || 1;
  return (
    <div className="rv-split">
      <div className="rv-split-bar" role="img" aria-label={`${label}: ${values.map((v) => `${v.value} ${fmt.pct(v.rows, total)}`).join(", ")}`}>
        {values.map((v, i) => (
          <span key={v.value} className={`rv-c${i % 5}`} style={{ width: `${(100 * v.rows) / total}%` }} title={`${v.value}: ${fmt.exact(v.rows)} rows`} />
        ))}
      </div>
      <ul className="rv-split-legend">
        {values.map((v, i) => (
          <li key={v.value}>
            <i className={`rv-c${i % 5}`} aria-hidden />
            <code>{v.value || "(empty)"}</code>
            <b>{fmt.pct(v.rows, total)}</b>
            <small title={fmt.exact(v.rows)}>{fmt.count(v.rows)} rows</small>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A long list with a search box and "show all". Rows are matched on their text cells. */
export function SearchList<T>({ items, text, render, label, first = 12 }: { items: T[]; text: (t: T) => string; render: (t: T) => React.ReactNode; label: string; first?: number }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const hits = q ? items.filter((t) => text(t).toLowerCase().includes(q.trim().toLowerCase())) : items;
  const shown = all || q ? hits : hits.slice(0, first);
  return (
    <div className="rv-searchlist">
      {items.length > first && (
        <label className="stage-search">
          <Icon name="search" size={15} />
          <input type="search" aria-label={`Search ${label}`} placeholder={`Search ${items.length} ${label}`} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      {shown.map(render)}
      {!q && items.length > first && (
        <button type="button" className="fg-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </div>
  );
}

// ---- tools for facts (measured, read-only) -----------------------------------------------------

/** A fact can only be given to the chat. Same place and look as a card's tools. */
export function FactBar({ id, ctx, note = "Measured" }: { id: string; ctx?: Pick<CardCtx, "mentioned" | "onMention">; note?: string | null }) {
  if (!ctx) return null;
  const asked = ctx.mentioned.has(id);
  return (
    <div className="card-bar card-float" role="toolbar" aria-label="Tools">
      {note && (
        <span className="card-fact-note" title={note === "Measured" ? "Measured from the warehouse. It cannot be edited." : undefined}>
          <Icon name="chart-bar" size={13} /> {note}
        </span>
      )}
      <button type="button" className={cn("card-at", asked && "on")} disabled={asked} onClick={() => ctx.onMention(id)} aria-label={asked ? "In the chat" : "Add to chat"} title={asked ? "In the chat" : "Add to chat as context"}>
        @
      </button>
    </div>
  );
}
