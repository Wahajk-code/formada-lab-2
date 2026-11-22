"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { Fragment, useMemo } from "react";

import { CardBar, CardEditor, GroupBar, type CardCtx } from "@/components/console/onboarding/card-tools";
import { DataTimeline } from "@/components/console/onboarding/data-timeline";
import {
  COVERAGE,
  FactBar,
  fmt,
  Fold,
  humanDates,
  humanName,
  isUnmeasuredNote,
  Lines,
  makeNamer,
  Name,
  SearchList,
  Section,
  Severity,
  shortName,
  SplitBar,
  Status,
  Sub,
} from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import { areaOf, cardId, issueTables, OVERVIEW, type AreaKey, type CardKind } from "@/lib/discovery-cards";
import type { OnboardingGuide } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/**
 * The data guide (docs/review-format.md). Answer first: what the scan found, which areas are
 * ready, how the main table behaves over time; then one card per area with what we have, its
 * tables and what to watch for, the technical detail folded; then the customer's own views.
 * AI findings can be edited, locked and mentioned; measured facts can be mentioned.
 */

const AREAS: { key: AreaKey; label: string; use: string; core: string; families: string[] }[] = [
  { key: "sales", label: "Sales", use: "Feeds sales metrics: revenue, units, discounts, returns and top sellers.", core: "sales", families: ["sales", "returns", "customers"] },
  { key: "inventory", label: "Inventory", use: "Feeds stock metrics: on hand, weeks of cover, stock-outs and overstock.", core: "inventory", families: ["inventory", "transfers"] },
  { key: "purchasing", label: "Purchasing", use: "Feeds purchasing metrics: open orders, late deliveries and supplier performance.", core: "purchase_orders", families: ["purchase_orders", "receipts", "vendors"] },
  { key: "shared", label: "Shared lookups", use: "Names and groups every area uses: calendar, locations and product groups.", core: "calendar", families: ["calendar"] },
];
const FAMILY: Record<string, string> = { purchase_orders: "Purchase orders" };
const familyName = (f: string) => FAMILY[f] ?? humanName(f);
const LINK = /^(\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\) -> (\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\)$/;
const clean = (s: string) => s.replace(/["\s]+/g, " ").trim();
const USE_FOR: Record<string, { tone: "ready" | "info" | "missing"; word: string }> = {
  map_from_view: { tone: "ready", word: "Map from this view" },
  map_from_tables: { tone: "info", word: "Map from the tables instead" },
  reference_only: { tone: "missing", word: "Reference only" },
};
/** "One row is the stock of ... 3,428,183 rows." -> "the stock of ..." */
const grainText = (g: string) =>
  String(g ?? "")
    .replace(/^one row (?:is|per)\s+/i, "")
    .replace(/\s*[\d,.]+\s+rows\.?\s*$/i, "")
    .replace(/\.$/, "");
/** The customer's views are the normal source (ADR 0033); a table read directly is the exception. */
const tableCount = (direct: number, view: number) =>
  !direct ? `${fmt.plural(view, "table")} in the customer's view` : !view ? `${fmt.plural(direct, "table")} read directly` : `${view} in the customer's view, ${direct} read directly`;
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
/** "The table contains records of shipped sales lines, ..." -> "Shipped sales lines, ..." (first sentence). */
const holds = (comment?: string | null) =>
  cap(
    firstSentence(
      String(comment ?? "")
        .replace(/^this (table|view)\s+/i, "")
        .replace(/^the (table|view)\s+(contains|stores|holds|captures|includes)\s+((records|information|data|details)\s+(of|on|about|for)\s+)?/i, "")
        .replace(/^(contains|stores|holds)\s+/i, ""),
      110,
    ),
  );
const firstSentence = (s: string, n = 120) => {
  const one = String(s ?? "").split(/(?<=\.)\s/)[0] ?? "";
  return one.length > n ? `${one.slice(0, n - 1).trimEnd()}…` : one;
};

// ---- rows shared with the "To resolve" tab ------------------------------------------------------

function Tools({ kind, item, owner, ctx }: { kind: CardKind; item: any; owner?: string; ctx?: CardCtx }) {
  if (!ctx) return null;
  const id = cardId(kind, item, owner);
  return (
    <>
      <CardBar id={id} ctx={ctx} />
      {ctx.editing === id && <CardEditor key={id} id={id} kind={kind} item={item} ctx={ctx} />}
    </>
  );
}
const openClass = (ctx: CardCtx | undefined, kind: CardKind, item: any) => ctx?.unlocked.has(cardId(kind, item)) && "is-open";

export function IssueRow({ q, ctx }: { q: any; ctx?: CardCtx }) {
  return (
    <article className={cn("rv-item card-hover", openClass(ctx, "issue", q))}>
      <div className="rv-item-head">
        <Severity level={q.severity} />
        <strong>{humanDates(q.title)}</strong>
      </div>
      <Lines
        rows={[
          ["What we found", humanDates(q.evidence)],
          ["Why it matters", humanDates(q.impact)],
          ["What we do", humanDates(q.suggested_handling)],
        ]}
      />
      <Tools kind="issue" item={q} ctx={ctx} />
    </article>
  );
}

export function CoverageRow({ c, ctx }: { c: any; ctx?: CardCtx }) {
  const s = COVERAGE[c.status] ?? COVERAGE.missing;
  return (
    <li className={cn("rv-cov card-hover", openClass(ctx, "coverage", c))}>
      <Status tone={s.tone}>{s.word}</Status>
      <b>{familyName(c.family)}</b>
      <span>{humanDates(c.evidence)}</span>
      <Tools kind="coverage" item={c} ctx={ctx} />
    </li>
  );
}

export function QuestionRow({ q, ctx, action }: { q: any; ctx?: CardCtx; action?: React.ReactNode }) {
  return (
    <article className={cn("rv-item rv-question card-hover", openClass(ctx, "question", q))}>
      <div className="rv-item-head">
        <Icon name="circle-help" size={16} />
        <strong>{humanDates(q.question)}</strong>
        {action && <div className="rv-item-action">{action}</div>}
      </div>
      <Lines rows={[["Why we ask", humanDates(q.why)], ["For", q.to === "team" ? "Our team" : "The customer"]]} />
      <Tools kind="question" item={q} ctx={ctx} />
    </article>
  );
}

// ---- joins declared in the customer's views -----------------------------------------------------

type ViewLink = { view: string; from: string; keys: string; to: string; ref: string };

/** The joins the customer's own views declare, each one once. */
export function viewLinks(views: NonNullable<OnboardingGuide["semantic_views"]>): ViewLink[] {
  const seen = new Set<string>();
  return views
    .flatMap((v) =>
      v.relationships.flatMap((raw) => {
        const m = LINK.exec(raw);
        return m ? [{ view: v.view, from: m[1], keys: clean(m[2]), to: m[3], ref: clean(m[4]) }] : [];
      }),
    )
    .filter((l) => {
      const k = `${l.from}|${l.keys}|${l.to}|${l.ref}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
}

/**
 * The Relationships tab, for the tables that arrive through the customer's views (ADR 0033): most
 * of sales, stock and purchasing. Without this the tab only showed tables read directly.
 */
export function ViewJoins({ guide, cards }: { guide: OnboardingGuide | null; cards?: CardCtx }) {
  const views = guide?.semantic_views ?? [];
  const links = viewLinks(views);
  if (!links.length) return null;
  const nameOf = makeNamer(views);
  const groups = AREAS.map((a) => ({ a, rows: links.filter((l) => areaOf(l.from) === a.key) })).filter((g) => g.rows.length);
  return (
    <Section
      id="rv-view-joins"
      icon="network"
      title="How the customer's views join"
      point="Sales, stock and purchasing reach us through the customer's own views, so these are the joins our numbers rest on. Read each line as: this table finds its match in that table, using this field."
    >
      {groups.map(({ a, rows }) => (
        <div key={a.key} className="rv-block card-hover">
          <Sub title={a.label} note={fmt.plural(rows.length, "join")} />
          <div className="stage-table-scroll">
            <table className="stage-table rv-compact">
              <thead>
                <tr>
                  <th scope="col">This table</th>
                  <th scope="col">Finds its match in</th>
                  <th scope="col">Using</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((l) => (
                  <tr key={`${l.from}${l.keys}${l.to}`}>
                    <td>{nameOf(l.from)}</td>
                    <td>{nameOf(l.to)}</td>
                    <td>
                      <code>{l.keys === l.ref ? l.keys : `${l.keys} = ${l.ref}`}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <FactBar id={`f:links:${a.key}`} ctx={cards} />
        </div>
      ))}
    </Section>
  );
}

// ---- the guide ----------------------------------------------------------------------------------

export function FullGuide({ out, guide, cards, onResolve }: { out: any; guide: OnboardingGuide | null; cards?: CardCtx; onResolve?: () => void }) {
  const profiles = useMemo(() => Object.fromEntries((guide?.profile.tables ?? []).map((t) => [t.table, t])), [guide]);
  const views = useMemo(() => guide?.semantic_views ?? [], [guide]);
  const nameOf = useMemo(() => makeNamer(guide?.semantic_views), [guide]);
  const time = guide?.time_profile;
  const tables: any[] = out.tables ?? [];
  const coverage: any[] = out.coverage ?? [];
  const issues: any[] = [...(out.quality_issues ?? [])].sort((a, b) => "hml".indexOf(a.severity[0]) - "hml".indexOf(b.severity[0]));
  const questions: any[] = out.questions ?? [];

  const links = useMemo(() => viewLinks(views), [views]);
  const semTables = useMemo(() => {
    const seen = new Set<string>();
    return views
      .flatMap((v) => v.tables.map((t) => ({ ...t, view: v.view })))
      .filter((t) => {
        const k = `${t.table}|${t.base_table}`;
        return seen.has(k) ? false : (seen.add(k), true);
      });
  }, [views]);

  // The main table over time: the profiled table that has the snapshot date column.
  const mainTable = useMemo(() => {
    const col = time?.date_column;
    return col ? (guide?.profile.tables ?? []).find((t) => t.columns.some((c) => c.column === col))?.table : undefined;
  }, [guide, time]);
  const mainHuman = useMemo(() => {
    const v = mainTable ? semTables.find((t) => t.base_table && shortName(t.base_table).toUpperCase() === shortName(mainTable).toUpperCase()) : undefined;
    return v ? humanName(v.table) : undefined;
  }, [mainTable, semTables]);
  // The column that says where each row came from (for example AUDIT_SOURCE): a name that points
  // at a source, more than one value, and the most rows behind it.
  const rowSource = useMemo(() => {
    const rowsOf = (c: { values: { rows: number }[] }) => c.values.reduce((n, v) => n + v.rows, 0);
    const found = (guide?.categories ?? []).filter((c) => /audit|source|origin|backfill|carried/i.test(c.column) && c.values.length > 1);
    return found.sort((a, b) => rowsOf(b) - rowsOf(a))[0];
  }, [guide]);

  const sections = AREAS.map((a) => {
    const base = tables.filter((t) => areaOf(t.table) === a.key);
    const baseShort = new Set(base.map((t) => shortName(t.table).toUpperCase()));
    const sem = semTables.filter((t) => areaOf(t.table) === a.key || (t.base_table && baseShort.has(shortName(t.base_table).toUpperCase())));
    const viewOnly = sem.filter((t) => !(t.base_table && baseShort.has(shortName(t.base_table).toUpperCase())));
    const viewFacts = viewOnly.filter((t) => t.metrics.length || /^fact_/i.test(shortName(t.base_table ?? "")));
    const viewLookups = viewOnly.filter((t) => !viewFacts.includes(t));
    const cov = coverage.filter((c) => a.families.includes(c.family));
    const core = cov.find((c) => c.family === a.core) ?? cov[0];
    return {
      ...a,
      base,
      sem,
      viewOnly,
      viewFacts,
      viewLookups,
      core,
      coverage: cov,
      links: links.filter((l) => areaOf(l.from) === a.key),
      issues: issues.filter((q) => issueTables(out, q).some((t) => areaOf(t) === a.key)),
    };
  }).filter((s) => s.base.length || s.sem.length || s.coverage.length);
  const placed = new Set(sections.flatMap((s) => s.issues));
  const general = issues.filter((q) => !placed.has(q));
  const highs = issues.filter((q) => q.severity === "high").length;
  const toSend = questions.filter((q) => q.to !== "team").length;

  const summary = String(out.summary ?? "")
    .split(/(?<=[.!?])\s+(?=[A-Z])/)
    .map((s) => s.trim())
    .filter(Boolean);

  return (
    <div className="rv">
      {/* 1. The answer: what the scan found */}
      <section className={cn("rv-summary card-hover", cards?.unlocked.has(OVERVIEW) && "is-open")} aria-labelledby="rv-summary-title">
        <p className="rv-eyebrow">
          <Icon name="sparkles" size={14} /> Summary · written by the AI, check it
        </p>
        <h4 id="rv-summary-title">What this scan found</h4>
        <ul>
          {summary.map((s) => (
            <li key={s}>{humanDates(s)}</li>
          ))}
        </ul>
        {(highs > 0 || questions.length > 0) && (
          <p className="rv-summary-next">
            {highs > 0 && <Status tone="decide">{fmt.plural(highs, "high issue")}</Status>}
            {toSend > 0 && <Status tone="decide">{fmt.plural(toSend, "question")} for the customer</Status>}
            {onResolve && (
              <button type="button" className="stage-inline-link" onClick={onResolve}>
                See what to resolve <Icon name="arrow-right" size={14} />
              </button>
            )}
          </p>
        )}
        {cards && <CardBar id={OVERVIEW} ctx={cards} />}
        {cards?.editing === OVERVIEW && <CardEditor id={OVERVIEW} kind="overview" item={out} ctx={cards} />}
      </section>

      {/* 2. Readiness: which areas we can launch */}
      <Section id="rv-ready" icon="target" title="Readiness by area" point="Which departments we can launch, and what each one still needs. Open an area for its tables.">
        <div className="rv-tiles">
          {sections.map((s) => {
            const st = COVERAGE[s.core?.status] ?? COVERAGE.missing;
            const others = s.coverage.filter((c) => c !== s.core);
            return (
              <a key={s.key} href={`#area-${s.key}`} className={cn("rv-tile", `rv-tile-${st.tone}`)}>
                <span className="rv-tile-top">
                  <b>{s.label}</b>
                  <Status tone={st.tone}>{st.word}</Status>
                </span>
                <span className="rv-tile-line">{s.core ? humanDates(s.core.evidence) : "No source found."}</span>
                {others.length > 0 && (
                  <span className="rv-tile-fams">
                    {others.map((c) => (
                      <span key={c.family} className={`rv-dot rv-dot-${(COVERAGE[c.status] ?? COVERAGE.missing).tone}`} title={(COVERAGE[c.status] ?? COVERAGE.missing).word}>
                        {familyName(c.family)}
                      </span>
                    ))}
                  </span>
                )}
                <span className="rv-tile-foot">{tableCount(s.base.length, s.viewOnly.length)}</span>
              </a>
            );
          })}
        </div>
      </Section>

      {/* 3. The main table over time */}
      {time && time.dates.length > 1 && (
        <Section
          id="rv-history"
          icon="calendar"
          title="The main table over time"
          point="Can we trust this table's history for trends? Hover the line to see a date and its row count."
          tools={<FactBar id="f:history" ctx={cards} />}
        >
          {mainTable && <Name technical={mainTable} human={mainHuman} />}
          <DataTimeline points={time.dates} breaks={time.breaks} />
          <Lines
            rows={[
              [
                "Empty at first",
                time.filled_late.length ? (
                  <>
                    {fmt.plural(time.filled_late.length, "field")} had no data until {fmt.date(time.filled_late[0].first_date)}
                    <span className="rv-muted"> (for example {time.filled_late.slice(0, 2).map((f) => humanName(f.column).toLowerCase()).join(", ")})</span>
                  </>
                ) : null,
              ],
            ]}
          />
          {rowSource && (
            <div className="rv-block card-hover">
              <Sub title="Where the rows come from" />
              <SplitBar values={rowSource.values.map((v) => ({ value: humanName(String(v.value ?? "")), rows: v.rows }))} label="Row source" />
              <FactBar id={`f:rows:${rowSource.column}`} ctx={cards} />
            </div>
          )}
        </Section>
      )}

      {/* 4. One card per area */}
      {sections.map((s) => {
        const st = COVERAGE[s.core?.status] ?? COVERAGE.missing;
        const measures = s.sem.filter((t) => t.metrics.length);
        const fieldCount = s.sem.reduce((n, t) => n + t.dimensions.length, 0) + s.base.reduce((n, t) => n + (profiles[t.table]?.columns.length ?? 0), 0);
        return (
          <Section
            key={s.key}
            id={`area-${s.key}`}
            className="rv-area"
            title={s.label}
            point={s.use}
            count={<Status tone={st.tone}>{st.word}</Status>}
            tools={cards && <GroupBar gid={`g:area:${s.key}`} ctx={cards} />}
          >
            {s.coverage.length > 0 && (
              <div className="rv-block">
                <Sub title="What we have" tools={cards && <GroupBar gid={`g:coverage:${s.key}`} ctx={cards} />} />
                <ul className="rv-covs">
                  {s.coverage.map((c) => (
                    <CoverageRow key={c.family} c={c} ctx={cards} />
                  ))}
                </ul>
              </div>
            )}

            {(s.base.length > 0 || s.viewOnly.length > 0) && (
              <div className="rv-block">
                <Sub title="Tables" note={tableCount(s.base.length, s.viewOnly.length)} tools={cards && <GroupBar gid={`g:tables:${s.key}`} ctx={cards} />} />
                {(s.base.length > 0 || s.viewFacts.length > 0) && (
                  <div className="rv-tables" role="table" aria-label={`${s.label} tables`}>
                    <div className="rv-tr rv-th" role="row">
                      <span role="columnheader">Table</span>
                      <span role="columnheader">What one row holds</span>
                      <span role="columnheader">Size</span>
                      <span role="columnheader">Source</span>
                    </div>
                    {s.base.map((t) => {
                      const p = profiles[t.table];
                      const inView = s.sem.find((v) => v.base_table && shortName(v.base_table).toUpperCase() === shortName(t.table).toUpperCase());
                      const id = cardId("table", t);
                      return (
                        <Fragment key={t.table}>
                          <div className={cn("rv-tr card-hover", cards?.unlocked.has(id) && "is-open")} role="row">
                            <span role="cell">
                              <Name technical={t.table} human={inView ? humanName(inView.table) : undefined} sub={<small className="rv-muted">{t.purpose}</small>} />
                            </span>
                            <span role="cell">
                              {cap(grainText(t.grain))}
                              {(t.key_columns ?? []).length > 0 && (
                                <small className="rv-key">
                                  Key <code>{t.key_columns.join(", ")}</code>
                                </small>
                              )}
                            </span>
                            <span role="cell" title={p?.rows != null ? `${fmt.exact(p.rows)} rows` : undefined}>
                              <b>{fmt.count(p?.rows)} rows</b>
                              <small className="rv-muted">{p?.columns.length ?? "–"} fields</small>
                            </span>
                            <span role="cell">
                              <Status tone="info">Table</Status>
                              {inView && <small className="rv-muted">Also in a customer view</small>}
                            </span>
                            {cards && <CardBar id={id} ctx={cards} />}
                          </div>
                          {cards?.editing === id && <CardEditor key={id} id={id} kind="table" item={t} ctx={cards} />}
                        </Fragment>
                      );
                    })}
                    {s.viewFacts.map((t) => (
                      <div key={`${t.view}.${t.table}`} className="rv-tr rv-tr-fact card-hover" role="row">
                        <span role="cell">
                          <Name technical={t.base_table ?? t.table} human={humanName(t.table)} />
                        </span>
                        <span role="cell">{holds(t.comment) || <span className="rv-muted">No description</span>}</span>
                        <span role="cell">
                          <b>{t.metrics.length ? fmt.plural(t.metrics.length, "measure") : "No measures"}</b>
                          <small className="rv-muted">{fmt.plural(t.dimensions.length, "field")}</small>
                        </span>
                        <span role="cell">
                          <Status tone="info">Customer view</Status>
                          {t.measured?.first_date && (
                            <small className="rv-muted">Data {fmt.range(String(t.measured.first_date), String(t.measured.last_date ?? ""), true)}</small>
                          )}
                        </span>
                        <FactBar id={`f:vtable:${t.table}`} ctx={cards} />
                      </div>
                    ))}
                  </div>
                )}
                {s.viewLookups.length > 0 && (
                  <Fold title="Lookups in the customer's view" note={`${s.viewLookups.length} tables of names and groups, no measures`}>
                    <div className="rv-lookups">
                      {s.viewLookups.map((t) => (
                        <div key={`${t.view}.${t.table}`} className="rv-lookup card-hover">
                          <Name technical={t.base_table ?? t.table} human={humanName(t.table)} />
                          <span className="rv-muted">{holds(t.comment)}</span>
                          <small className="rv-muted">{fmt.plural(t.dimensions.length, "field")}</small>
                          <FactBar id={`f:vtable:${t.table}`} ctx={cards} />
                        </div>
                      ))}
                    </div>
                  </Fold>
                )}
              </div>
            )}

            {s.issues.length > 0 && (
              <div className="rv-block">
                <Sub title="What to watch for" note={fmt.plural(s.issues.length, "issue")} tools={cards && <GroupBar gid={`g:issues:${s.key}`} ctx={cards} />} />
                <div className="rv-items">
                  {s.issues.map((q) => (
                    <IssueRow key={q.title} q={q} ctx={cards} />
                  ))}
                </div>
              </div>
            )}

            {(s.links.length > 0 || measures.length > 0 || fieldCount > 0) && (
              <Fold
                title="For engineers: links, measures and fields"
                note={[s.links.length && fmt.plural(s.links.length, "link"), measures.length && fmt.plural(measures.reduce((n, t) => n + t.metrics.length, 0), "measure"), fieldCount && fmt.plural(fieldCount, "field")].filter(Boolean).join(" · ")}
              >
                {s.links.length > 0 && (
                  <div className="rv-block card-hover">
                    <Sub title="How the tables connect" note="declared in the customer's views" />
                    <div className="stage-table-scroll">
                      <table className="stage-table rv-compact">
                        <thead>
                          <tr>
                            <th scope="col">From</th>
                            <th scope="col">To</th>
                            <th scope="col">Matched on</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.links.map((l) => (
                            <tr key={`${l.from}${l.keys}${l.to}`}>
                              <td>{nameOf(l.from)}</td>
                              <td>{nameOf(l.to)}</td>
                              <td>
                                <code>{l.keys === l.ref ? l.keys : `${l.keys} = ${l.ref}`}</code>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <FactBar id={`f:links:${s.key}`} ctx={cards} />
                  </div>
                )}
                {measures.length > 0 && (
                  <div className="rv-block">
                    <Sub title="The customer's measures" note="their own formulas" />
                    {measures.map((t) => (
                      <Fold key={t.table} title={humanName(t.table)} note={fmt.plural(t.metrics.length, "measure")}>
                        <SearchList
                          items={t.metrics}
                          label="measures"
                          text={(m) => `${m.name} ${m.comment}`}
                          render={(m) => (
                            <div key={m.name} className="rv-def">
                              <b>{humanName(m.name)}</b>
                              <span>{m.comment || ""}</span>
                              <code>{m.expression}</code>
                            </div>
                          )}
                        />
                      </Fold>
                    ))}
                  </div>
                )}
                {fieldCount > 0 && (
                  <div className="rv-block">
                    <Sub title="Fields" />
                    {s.base
                      .filter((t) => profiles[t.table]?.columns.length)
                      .map((t) => (
                        <Fold key={`b-${t.table}`} title={shortName(t.table)} note={`${profiles[t.table]!.columns.length} fields · measured on the table`}>
                          <SearchList
                            items={profiles[t.table]!.columns}
                            label="fields"
                            text={(c) => c.column}
                            render={(c) => (
                              <div key={c.column} className="rv-field">
                                <code>{c.column}</code>
                                <small>{(c.type ?? "").toLowerCase()}</small>
                                <span className={cn("rv-fill", c.fill_pct != null && c.fill_pct < 50 && "low")} title="Share of rows where it is filled">
                                  <i style={{ ["--p" as string]: `${c.fill_pct ?? 0}%` }} />
                                  {c.fill_pct == null ? "–" : `${Math.round(c.fill_pct)}% filled`}
                                </span>
                                <small>{c.distinct == null ? "" : `${fmt.count(c.distinct)} distinct`}</small>
                              </div>
                            )}
                          />
                        </Fold>
                      ))}
                    {s.sem
                      .filter((t) => t.dimensions.length)
                      .map((t) => (
                        <Fold key={`s-${t.table}`} title={humanName(t.table)} note={`${t.dimensions.length} fields · the customer's descriptions`}>
                          <SearchList
                            items={t.dimensions}
                            label="fields"
                            text={(d) => `${d.name} ${d.comment}`}
                            render={(d) => (
                              <div key={d.name} className="rv-def">
                                <code>{d.name}</code>
                                <span>{d.comment || ""}</span>
                                <small>{(d.type ?? "").toLowerCase()}</small>
                              </div>
                            )}
                          />
                        </Fold>
                      ))}
                  </div>
                )}
              </Fold>
            )}
          </Section>
        );
      })}

      {general.length > 0 && (
        <Section id="rv-general" icon="danger-circle" title="Across areas" point="Issues that touch more than one area." tools={cards && <GroupBar gid="g:issues:general" ctx={cards} />}>
          <div className="rv-items">
            {general.map((q) => (
              <IssueRow key={q.title} q={q} ctx={cards} />
            ))}
          </div>
        </Section>
      )}

      {/* 5. The customer's own views */}
      {(out.semantic_views ?? []).length > 0 && (
        <Section
          id="rv-views"
          icon="layers"
          title="The customer's semantic views"
          point="Models the customer already keeps. For each one: whether mapping should read from it, and what it cannot answer."
          tools={cards && <GroupBar gid="g:views" ctx={cards} />}
        >
          <div className="rv-items">
            {(out.semantic_views as any[]).map((v) => {
              const use = USE_FOR[v.use_for] ?? USE_FOR.reference_only;
              const graph = (out.view_links as any[] | undefined)?.find((g) => g.view === v.view);
              return (
                <article key={v.view} className={cn("rv-item card-hover", openClass(cards, "view", v))}>
                  <div className="rv-item-head">
                    <Name technical={v.view} />
                    <Status tone={use.tone}>{use.word}</Status>
                  </div>
                  <Lines
                    rows={[
                      ["What it models", humanDates(v.purpose)],
                      ["What one row is", cap(grainText(v.grain))],
                      ["Size", graph ? `${fmt.plural(graph.tables, "table")}, ${fmt.plural(graph.links, "link")}${graph.unlinked_tables?.length ? `, ${graph.unlinked_tables.length} not linked` : ""}` : null],
                      ["Covers", (v.families ?? []).length ? (v.families as string[]).map(familyName).join(", ") : null],
                      [
                        "Cannot answer",
                        (v.caveats as string[] | undefined)?.some((c) => !isUnmeasuredNote(c)) ? (
                          <ul className="rv-list">
                            {(v.caveats as string[]).filter((c) => !isUnmeasuredNote(c)).map((c) => (
                              <li key={c}>{humanDates(c)}</li>
                            ))}
                          </ul>
                        ) : null,
                      ],
                    ]}
                  />
                  <Tools kind="view" item={v} ctx={cards} />
                </article>
              );
            })}
          </div>
        </Section>
      )}

      {(guide?.key_overlaps ?? []).length > 0 && (
        <Section
          id="rv-overlap"
          icon="network"
          title="Cross-checks between areas"
          point="Metrics that combine two areas (weeks of cover, top sellers running out) need the same item code on both sides. Below 60% means they use different codes."
          tools={<FactBar id="f:overlap" ctx={cards} />}
        >
          {(guide?.key_overlaps ?? []).map((o) => (
            <div key={o.left + o.right} className="rv-overlap">
              <span>
                <b>{nameOf(o.left)}</b> and <b>{nameOf(o.right)}</b>
              </span>
              <span className={cn("rv-fill", o.pct_of_right < 60 && "low")}>
                <i style={{ ["--p" as string]: `${o.pct_of_right}%` }} />
                {Math.round(o.pct_of_right)}% of codes match
              </span>
              <small className="rv-muted">
                {fmt.exact(o.shared)} of {fmt.exact(o.right_codes)} recently sold codes are in the stock table
              </small>
            </div>
          ))}
        </Section>
      )}
    </div>
  );
}
