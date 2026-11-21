"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { Fragment, useMemo, useState } from "react";

import { CardBar, CardEditor, GroupBar, type CardCtx } from "@/components/console/onboarding/card-tools";
import { Icon } from "@/components/ui/icon";
import { areaOf, cardId, OVERVIEW } from "@/lib/discovery-cards";
import type { OnboardingGuide } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/**
 * The data guide, in the reference-manual format reviewed in the artifact (variation A):
 * an overview, then one section per business area with Tables, How the tables connect,
 * Measures and Fields; inventory adds which rows are real and the snapshot history;
 * then cross-checks between areas and the questions for the customer.
 */

const int = new Intl.NumberFormat("en-CA");
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const words = (s: string) => s.replace(/_/g, " ");
const short = (t: string) => t.split(".").pop() ?? t;
const plain = (s: string) => cap(words(s.toLowerCase()));

type AreaKey = "sales" | "inventory" | "purchasing" | "shared";
const AREAS: { key: AreaKey; label: string; blurb: string; families: string[] }[] = [
  { key: "sales", label: "Sales", blurb: "Orders, invoices, cash sales, customers, returns and forecasts.", families: ["sales", "returns", "customers"] },
  { key: "inventory", label: "Inventory", blurb: "Stock on hand by item and location, and stock moving between locations.", families: ["inventory", "transfers"] },
  { key: "purchasing", label: "Purchasing", blurb: "Purchase orders, vendors and what has been received.", families: ["purchase_orders", "receipts", "vendors"] },
  { key: "shared", label: "Shared lookups", blurb: "Calendar, locations and product groups every area uses.", families: ["calendar"] },
];
const LINK = /^(\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\) -> (\S+) \(\s*\[?\s*([\s\S]*?)\s*\]?\s*\)$/;
const clean = (s: string) => s.replace(/["\s]+/g, " ").trim();

function Chip({ tone = "neutral", children }: { tone?: "neutral" | "positive" | "attention" | "accent"; children: React.ReactNode }) {
  return <span className={cn("stage-badge", tone !== "neutral" && tone)}>{children}</span>;
}
/** A heading with the tools of its whole block (unlock or lock all, or give it to the chat). */
function Head({ gid, cards, children }: { gid: string; cards?: CardCtx; children: React.ReactNode }) {
  return (
    <div className="fg-head card-hover">
      {children}
      {cards && <GroupBar gid={gid} ctx={cards} />}
    </div>
  );
}
const STATUS_TONE = { present: "positive", partial: "attention", missing: "attention" } as const;
const SEVERITY_TONE = { high: "attention", medium: "accent", low: "neutral" } as const;

function Fold({ title, note, children, open }: { title: string; note?: string; children: React.ReactNode; open?: boolean }) {
  return (
    <details className="fg-fold" open={open}>
      <summary>
        <strong>{title}</strong>
        {note && <small>{note}</small>}
        <Icon name="chevron-down" size={15} />
      </summary>
      <div className="fg-fold-body">{children}</div>
    </details>
  );
}

function Grid({ head, rows, after, hover }: { head: string[]; rows: React.ReactNode[][]; after?: (i: number) => React.ReactNode; hover?: boolean }) {
  return (
    <div className="stage-table-scroll">
      <table className="stage-table">
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={h} scope="col" className={hover && i === head.length - 1 ? "card-cell" : undefined}>
                {hover && i === head.length - 1 ? <span className="stage-visually-hidden">{h}</span> : h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <Fragment key={i}>
              <tr className={hover ? "card-hover" : undefined}>
                {r.map((c, j) => (
                  <td key={j} className={hover && j === r.length - 1 ? "card-cell" : undefined}>
                    {c}
                  </td>
                ))}
              </tr>
              {after?.(i) ? (
                <tr className="fg-after">
                  <td colSpan={head.length}>{after(i)}</td>
                </tr>
              ) : null}
            </Fragment>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A long field list with a search box, as in the reference manual. */
function FieldList({ head, rows, label }: { head: string[]; rows: React.ReactNode[][]; label: string }) {
  const [q, setQ] = useState("");
  const [all, setAll] = useState(false);
  const text = (r: React.ReactNode[]) => r.map((c) => (typeof c === "string" ? c : "")).join(" ").toLowerCase();
  const hits = rows.filter((r) => text(r).includes(q.trim().toLowerCase()));
  const shown = all || q ? hits : hits.slice(0, 15);
  return (
    <div className="fg-fields">
      {rows.length > 15 && (
        <label className="stage-search">
          <Icon name="search" size={15} />
          <input type="search" aria-label={`Search fields of ${label}`} placeholder={`Search ${rows.length} fields`} value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
      )}
      <Grid head={head} rows={shown} />
      {!q && rows.length > 15 && (
        <button type="button" className="fg-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer fields" : `Show all ${rows.length} fields`}
        </button>
      )}
    </div>
  );
}

export function FullGuide({ out, guide, cards }: { out: any; guide: OnboardingGuide | null; cards?: CardCtx }) {
  const profiles = useMemo(() => Object.fromEntries((guide?.profile.tables ?? []).map((t) => [t.table, t])), [guide]);
  const views = useMemo(() => guide?.semantic_views ?? [], [guide]);
  const time = guide?.time_profile;
  const tables: any[] = out.tables ?? [];
  const coverage: any[] = out.coverage ?? [];
  const issues: any[] = [...(out.quality_issues ?? [])].sort((a, b) => "hml".indexOf(a.severity[0]) - "hml".indexOf(b.severity[0]));
  const [open, setOpen] = useState<AreaKey | "all">("all");

  const links = useMemo(() => {
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
  }, [views]);
  const semTables = useMemo(() => {
    const seen = new Set<string>();
    return views
      .flatMap((v) => v.tables.map((t) => ({ ...t, view: v.view })))
      .filter((t) => {
        const k = `${t.table}|${t.base_table}`;
        return seen.has(k) ? false : (seen.add(k), true);
      });
  }, [views]);
  const factTables = semTables.filter((t) => t.metrics.length);
  const dateCount = time?.dates.length ?? 0;

  const sections = AREAS.map((a) => {
    const base = tables.filter((t) => areaOf(t.table) === a.key);
    const names = new Set(base.flatMap((t) => [t.table, short(t.table)]));
    const sem = semTables.filter((t) => areaOf(t.table) === a.key);
    return {
      ...a,
      base,
      sem,
      links: links.filter((l) => areaOf(l.from) === a.key || areaOf(l.to) === a.key).filter((l) => sem.some((t) => t.table === l.from)),
      coverage: coverage.filter((c) => a.families.includes(c.family)),
      issues: issues.filter((q) =>
        (q.columns ?? []).some((c: string) => {
          const t = c.split(".").slice(0, -1).join(".");
          return names.has(t) || names.has(short(t));
        }),
      ),
    };
  });
  const placed = new Set(sections.flatMap((s) => s.issues));
  const general = issues.filter((q) => !placed.has(q));
  const visible = sections.filter((s) => (open === "all" || open === s.key) && (s.base.length || s.sem.length));

  const tools = (kind: "table" | "issue" | "coverage" | "question" | "view", item: any) => {
    if (!cards) return null;
    const id = cardId(kind, item);
    return (
      <>
        <CardBar id={id} ctx={cards} />
        {cards.editing === id && <CardEditor key={id} id={id} kind={kind} item={item} ctx={cards} />}
      </>
    );
  };
  const isOpen = (kind: "table" | "issue" | "coverage" | "question" | "view", item: any) =>
    Boolean(cards?.unlocked.has(cardId(kind, item)));

  const issueRow = (q: any, i: number) => (
    <article key={i} className={cn("fg-issue card-hover", isOpen("issue", q) && "is-open")}>
      <div>
        <strong>{q.title}</strong>
        <p>{q.evidence}</p>
        <p>
          <b>Impact:</b> {q.impact} <b>How we handle it:</b> {q.suggested_handling}
        </p>
        {tools("issue", q)}
      </div>
      <Chip tone={SEVERITY_TONE[q.severity as keyof typeof SEVERITY_TONE]}>{cap(q.severity)}</Chip>
    </article>
  );

  return (
    <div className="fg">
      <div className={cn("fg-overview card-hover", cards?.unlocked.has(OVERVIEW) && "is-open")}>
        <p className="stage-helper fg-summary">{out.summary}</p>
        {cards && <CardBar id={OVERVIEW} ctx={cards} />}
        {cards?.editing === OVERVIEW && <CardEditor id={OVERVIEW} kind="overview" item={out} ctx={cards} />}
      </div>
      <dl className="source-totals">
        <div>
          <dt>Tables profiled</dt>
          <dd>{tables.length}</dd>
        </div>
        <div>
          <dt>Declared links</dt>
          <dd>{int.format(links.length)}</dd>
        </div>
        <div>
          <dt>Fact tables</dt>
          <dd>{factTables.length || tables.filter((t) => t.kind === "fact").length}</dd>
        </div>
        <div>
          <dt>Snapshot dates</dt>
          <dd>{dateCount ? int.format(dateCount) : "–"}</dd>
        </div>
      </dl>

      <div className="stage-segmented fg-jump" role="group" aria-label="Guide sections">
        <button type="button" aria-pressed={open === "all"} onClick={() => setOpen("all")}>
          All areas
        </button>
        {sections
          .filter((s) => s.base.length || s.sem.length)
          .map((s) => (
            <button key={s.key} type="button" aria-pressed={open === s.key} onClick={() => setOpen(s.key)}>
              {s.label}
            </button>
          ))}
      </div>

      {visible.map((s) => (
        <section key={s.key} className="fg-area" aria-labelledby={`fg-${s.key}`}>
          <header className="card-hover">
            <div>
              <h5 id={`fg-${s.key}`}>{s.label}</h5>
              <p>{s.blurb}</p>
            </div>
            <div className="fg-chips">
              {s.coverage.map((c) => (
                <Chip key={c.family} tone={STATUS_TONE[c.status as keyof typeof STATUS_TONE]}>
                  {plain(c.family)}: {c.status}
                </Chip>
              ))}
            </div>
          {cards && <GroupBar gid={`g:area:${s.key}`} ctx={cards} />}</header>

          {s.coverage.length > 0 && cards && (
            <Head gid={`g:coverage:${s.key}`} cards={cards}>
              <h6>Coverage</h6>
            </Head>
          )}

          {s.coverage.length > 0 && (
            <ul className="fg-evidence">
              {s.coverage.map((c) => (
                <li key={c.family} className={cn("card-hover", isOpen("coverage", c) && "is-open")}>
                  <strong>{plain(c.family)}</strong> {c.evidence}
                  {tools("coverage", c)}
                </li>
              ))}
            </ul>
          )}

          {s.base.length > 0 && (
            <>
              <Head gid={`g:tables:${s.key}`} cards={cards}>
                <h6>Tables</h6>
              </Head>
              <Grid
                head={cards ? ["Table", "Kind", "Rows", "Fields", "One row is", "Key", "Card tools"] : ["Table", "Kind", "Rows", "Fields", "One row is", "Key"]}
                hover={Boolean(cards)}
                after={(i) => (cards && cards.editing === cardId("table", s.base[i]) ? tools("table", s.base[i]) : null)}
                rows={s.base.map((t) => [
                  <code key="t">{t.table}</code>,
                  cap(t.kind),
                  <span key="r" className="stage-mono">{profiles[t.table]?.rows != null ? int.format(profiles[t.table]!.rows as number) : "–"}</span>,
                  <span key="c" className="stage-mono">{profiles[t.table]?.columns.length ?? "–"}</span>,
                  t.grain.replace(/^(one( row)?( is| per)?\s+)/i, ""),
                  <code key="k">{(t.key_columns ?? []).join(", ") || "none found"}</code>,
                  ...(cards ? [<CardBar key="card" id={cardId("table", t)} ctx={cards} />] : []),
                ])}
              />
            </>
          )}

          {s.sem.length > 0 && (
            <>
              <h6>Tables in the customer&apos;s views</h6>
              <Grid
                head={["Table", "Reads", "Role", "Measures", "Fields", "Measured"]}
                rows={s.sem.map((t) => [
                  <b key="n">{plain(t.table)}</b>,
                  <code key="b">{t.base_table ?? "–"}</code>,
                  t.metrics.length ? "Fact" : "Lookup",
                  t.metrics.length || "–",
                  t.dimensions.length,
                  t.measured ? `${t.measured.first_date} to ${t.measured.last_date}` : <Chip key="m">Not measured</Chip>,
                ])}
              />
            </>
          )}

          {s.links.length > 0 && (
            <>
              <h6>How the tables connect</h6>
              <Fold title="Every link from these tables" note={`${s.links.length} declared by the customer`} open={s.links.length <= 12}>
                <Grid
                  head={["From", "Keys", "To", "Reference"]}
                  rows={s.links.map((l) => [plain(l.from), <code key="k">{l.keys}</code>, plain(l.to), <code key="r">{l.ref}</code>])}
                />
              </Fold>
            </>
          )}

          {s.sem.some((t) => t.metrics.length) && (
            <>
              <h6>Measures</h6>
              {s.sem
                .filter((t) => t.metrics.length)
                .map((t) => (
                  <Fold key={t.table} title={plain(t.table)} note={`${t.metrics.length} measures`}>
                    <Grid
                      head={["Measure", "Formula", "What it means"]}
                      rows={t.metrics.map((m) => [<b key="n">{plain(m.name)}</b>, <code key="e">{m.expression}</code>, m.comment || "–"])}
                    />
                  </Fold>
                ))}
            </>
          )}

          {(s.sem.length > 0 || s.base.length > 0) && (
            <>
              <h6>Fields</h6>
              {s.sem
                .filter((t) => t.dimensions.length)
                .map((t) => (
                  <Fold key={`sem-${t.table}`} title={plain(t.table)} note={`${t.dimensions.length} fields · customer's descriptions`}>
                    <FieldList
                      label={t.table}
                      head={["Field", "Type", "What the customer says it is"]}
                      rows={t.dimensions.map((d) => [<span key="n" className="stage-mono">{d.name}</span>, (d.type ?? "").toLowerCase(), d.comment || "–"])}
                    />
                  </Fold>
                ))}
              {s.base
                .filter((t) => profiles[t.table]?.columns.length)
                .map((t) => (
                  <Fold key={`base-${t.table}`} title={short(t.table)} note={`${profiles[t.table]!.columns.length} fields · measured on the table`}>
                    <FieldList
                      label={t.table}
                      head={["Field", "Type", "Filled", "Distinct values"]}
                      rows={profiles[t.table]!.columns.map((c) => [
                        <span key="n" className="stage-mono">{c.column}</span>,
                        (c.type ?? "").toLowerCase(),
                        <span key="f" className={cn("stage-mono", c.fill_pct != null && c.fill_pct < 50 && "fg-low")}>{c.fill_pct == null ? "–" : `${Math.round(c.fill_pct)}%`}</span>,
                        <span key="d" className="stage-mono">{c.distinct == null ? "–" : int.format(c.distinct)}</span>,
                      ])}
                    />
                  </Fold>
                ))}
            </>
          )}

          {s.key === "inventory" && time && (
            <>
              {(guide?.categories ?? []).length > 0 && (
                <>
                  <h6>Which rows are real</h6>
                  {(guide?.categories ?? []).slice(0, 2).map((c) => {
                    const total = c.values.reduce((n, v) => n + v.rows, 0) || 1;
                    return (
                      <div key={c.column} className="fg-bars">
                        <p className="stage-helper">
                          <code>{c.column}</code> tells real counts from copied or back-filled rows.
                        </p>
                        {c.values.map((v) => (
                          <div key={v.value} className="fg-bar">
                            <span>{v.value}</span>
                            <i style={{ ["--share" as string]: `${(100 * v.rows) / total}%` }} />
                            <b className="stage-mono">{int.format(v.rows)}</b>
                          </div>
                        ))}
                      </div>
                    );
                  })}
                </>
              )}
              {time.cadence.length > 0 && (
                <>
                  <h6>Rows per snapshot date</h6>
                  <Grid
                    head={["From", "To", "Every", "Snapshots"]}
                    rows={time.cadence.map((r: any) => [r.from, r.to, `${r.step_days} days`, <span key="c" className="stage-mono">{r.count}</span>])}
                  />
                  {time.breaks.length > 0 && (
                    <ul className="fg-evidence">
                      {time.breaks.map((b: any, i: number) => (
                        <li key={i}>
                          <strong>Row count drops</strong> between {b.from} and {b.to}: {b.rows?.map((n: number) => int.format(n)).join(" then ")} rows.
                        </li>
                      ))}
                    </ul>
                  )}
                  {time.filled_late.length > 0 && (
                    <p className="stage-helper">
                      {time.filled_late.length} fields were empty before they started filling in, for example <code>{time.filled_late[0].column}</code> from {time.filled_late[0].first_date}.
                    </p>
                  )}
                </>
              )}
            </>
          )}

          {s.issues.length > 0 && (
            <>
              <Head gid={`g:issues:${s.key}`} cards={cards}>
                <h6>Data quality in {s.label.toLowerCase()}</h6>
              </Head>
              <div className="fg-issues">{s.issues.map(issueRow)}</div>
            </>
          )}
        </section>
      ))}

      {open === "all" && general.length > 0 && (
        <section className="fg-area">
          <header className="card-hover">
            <div>
              <h5>Across areas</h5>
              <p>Data quality findings that are not tied to one area.</p>
            </div>
          {cards && <GroupBar gid="g:issues:general" ctx={cards} />}</header>
          <div className="fg-issues">{general.map(issueRow)}</div>
        </section>
      )}

      {open === "all" && (guide?.key_overlaps ?? []).length > 0 && (
        <section className="fg-area">
          <header>
            <div>
              <h5>Cross-checks between areas</h5>
              <p>Metrics that combine two areas (weeks of cover, top sellers running out) need the same item code on both sides.</p>
            </div>
          </header>
          {(guide?.key_overlaps ?? []).map((o) => (
            <div key={o.left + o.right} className="fg-bars">
              <p>
                <b>{short(o.left)}</b> against <b>{short(o.right)}</b>
              </p>
              <div className="fg-bar">
                <span>{Math.round(o.pct_of_right)}% match</span>
                <i style={{ ["--share" as string]: `${o.pct_of_right}%` }} />
              </div>
              <p className="stage-helper">
                {int.format(o.shared)} of {int.format(o.right_codes)} recently sold item codes also exist in the stock table ({int.format(o.left_codes)} stock codes). Below 60% means the two use different codes.
              </p>
            </div>
          ))}
        </section>
      )}

      {open === "all" && (out.semantic_views ?? []).length > 0 && (
        <section className="fg-area">
          <header className="card-hover">
            <div>
              <h5>Customer semantic views</h5>
              <p>Views the customer already keeps. They name the measures and say how tables join.</p>
            </div>
          {cards && <GroupBar gid="g:views" ctx={cards} />}</header>
          <div className="fg-issues">
            {(out.semantic_views as any[]).map((v) => (
              <article key={v.view} className={cn("fg-issue card-hover", isOpen("view", v) && "is-open")}>
                <div>
                  <strong>{v.view}</strong>
                  <p>{v.purpose}</p>
                  <p>
                    <b>One row is:</b> {v.grain}
                    {(v.caveats ?? []).length > 0 && (
                      <>
                        {" "}
                        <b>Cannot answer:</b> {(v.caveats as string[]).join(" ")}
                      </>
                    )}
                  </p>
                  {tools("view", v)}
                </div>
                <Chip tone={v.use_for === "map_from_view" ? "positive" : "neutral"}>{cap(words(v.use_for))}</Chip>
              </article>
            ))}
          </div>
        </section>
      )}

      {open === "all" && (out.questions ?? []).length > 0 && (
        <section className="fg-area">
          <header className="card-hover">
            <div>
              <h5>Questions for the customer</h5>
              <p>Open items the guide could not settle from the data alone.</p>
            </div>
          {cards && <GroupBar gid="g:questions" ctx={cards} />}</header>
          <Grid
            head={cards ? ["Question", "Why it matters", "For", "Card tools"] : ["Question", "Why it matters", "For"]}
            hover={Boolean(cards)}
            after={(i) => (cards && cards.editing === cardId("question", (out.questions as any[])[i]) ? tools("question", (out.questions as any[])[i]) : null)}
            rows={(out.questions as any[]).map((q) => [
              q.question,
              q.why,
              q.to === "team" ? "The team" : "The customer",
              ...(cards ? [<CardBar key="card" id={cardId("question", q)} ctx={cards} />] : []),
            ])}
          />
        </section>
      )}
    </div>
  );
}
