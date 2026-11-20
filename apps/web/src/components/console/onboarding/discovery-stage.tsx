"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { askClient, askWorkspaceAI, lockDiscoverySection, reviseDiscoverySection } from "@/app/console-actions";
import { EngineerChat } from "@/components/console/onboarding/engineer-chat";
import { cn } from "@/lib/utils";
import { FullGuide } from "@/components/console/onboarding/full-guide";
import { Icon, type IconName } from "@/components/ui/icon";
import type { AssistantTurn } from "@/lib/client-api";
import type { OnboardingGuide } from "@/lib/console-api";

type Section = "guide" | "relationships" | "gaps";
type Dimension = "tables" | "columns" | "rows";

const SECTIONS: Record<Section, string> = { guide: "Data guide", relationships: "Relationships", gaps: "Coverage gaps" };
const DIMENSIONS: Record<Dimension, string> = { tables: "Tables", columns: "Columns", rows: "Rows profiled" };
const STARTERS: Record<Section, string[]> = {
  guide: ["What is the main table and why?", "Which table holds the stock counts?"],
  relationships: ["Which join needs review?", "How do the tables connect?"],
  gaps: ["Why is this area missing?", "What should we ask the customer?"],
};
const integer = new Intl.NumberFormat("en-CA");
const compact = new Intl.NumberFormat("en-CA", { notation: "compact", maximumFractionDigits: 1 });
const short = (t: string) => t.split(".").pop() ?? t;
const schemaOf = (t: string) => {
  const parts = t.split(".");
  return parts.length > 1 ? parts[parts.length - 2] : "SOURCE";
};
const words = (s: string) => s.replaceAll("_", " ");
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function Badge({ kind = "neutral", icon, children }: { kind?: "neutral" | "positive" | "attention" | "accent"; icon?: IconName; children: React.ReactNode }) {
  return (
    <span className={`stage-badge ${kind}`}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

function PanelTitle({ title, description, icon, extra }: { title: string; description: string; icon: IconName; extra?: React.ReactNode }) {
  return (
    <div className="stage-panel-heading">
      <span className="stage-heading-icon">
        <Icon name={icon} size={19} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
      {extra}
    </div>
  );
}

type TableRow = {
  table: string;
  schema: string;
  kind: string;
  grain: string;
  purpose: string;
  keys: string[];
  joins: { column: string; references_table: string; references_column: string; confidence: string }[];
  rows: number;
  columns: { column: string; fill_pct: number | null }[];
};

// ---------------------------------------------------------------------------------------------
// Table relationship diagram (design: discoverySchema)
// ---------------------------------------------------------------------------------------------

function SchemaDiagram({ tables }: { tables: TableRow[] }) {
  const inset = 22;
  const tableWidth = 190;
  const columnGap = 48;
  const headerHeight = 50;
  const fieldHeight = 23;
  const rowGap = 52;
  const maxFields = 5;
  const maxTableHeight = headerHeight + fieldHeight * maxFields + 6;
  const rowPitch = maxTableHeight + rowGap;
  const rowsN = Math.max(1, Math.ceil(tables.length / 3));
  const width = inset * 2 + tableWidth * 3 + columnGap * 2;
  const height = inset * 2 + (rowsN - 1) * rowPitch + maxTableHeight + rowGap / 2;
  const byName = new Map(tables.map((t) => [t.table, t]));
  const resolve = (name: string) => tables.find((t) => t.table === name || short(t.table).toUpperCase() === short(name).toUpperCase());

  // Which fields to draw: the join ends first, then the keys, up to five.
  const wanted = new Map<string, string[]>(tables.map((t) => [t.table, []]));
  const add = (t: string, c: string) => {
    const list = wanted.get(t);
    if (list && !list.includes(c) && list.length < maxFields) list.push(c);
  };
  for (const t of tables)
    for (const j of t.joins) {
      const ref = resolve(j.references_table);
      add(t.table, j.column);
      if (ref) add(ref.table, j.references_column);
    }
  for (const t of tables) for (const k of t.keys) add(t.table, short(k));

  // Facts first, so the joins read from the middle of the picture outward.
  const order = [...tables].sort((a, b) => Number(b.kind === "fact") - Number(a.kind === "fact"));
  const placed = new Map(
    order.map((t, i) => {
      const row = Math.floor(i / 3);
      return [t.table, { t, row, x: inset + (i % 3) * (tableWidth + columnGap), y: inset + row * rowPitch, fields: wanted.get(t.table) ?? [] }] as const;
    }),
  );
  const linked = new Set<string>();
  const wires = tables.flatMap((t, index) =>
    t.joins.flatMap((j) => {
      const refTable = resolve(j.references_table);
      const from = placed.get(t.table);
      const to = refTable ? placed.get(refTable.table) : undefined;
      if (!from || !to || from === to || !from.fields.includes(j.column) || !to.fields.includes(j.references_column)) return [];
      linked.add(`${t.table}.${j.column}`);
      linked.add(`${to.t.table}.${j.references_column}`);
      const fromRight = from.x <= to.x;
      const toRight = to.x <= from.x;
      const startX = from.x + (fromRight ? tableWidth : 0);
      const endX = to.x + (toRight ? tableWidth : 0);
      const portY = (p: typeof from, f: string) => p.y + headerHeight + fieldHeight * (p.fields.indexOf(f) + 0.5);
      const startY = portY(from, j.column);
      const endY = portY(to, j.references_column);
      const bendX = (startX + endX) / 2;
      const aisleRow = Math.min(from.row, to.row);
      const aisleY = inset + aisleRow * rowPitch + maxTableHeight + rowGap / 2;
      const lane = 12 + (index % 3) * 5;
      const startRail = startX + (fromRight ? lane : -lane);
      const endRail = endX + (toRight ? lane : -lane);
      const route =
        from.row === to.row && Math.abs(startX - endX) === columnGap
          ? `C ${bendX} ${startY} ${bendX} ${endY} ${endX} ${endY}`
          : `H ${startRail} V ${aisleY} H ${endRail} V ${endY} H ${endX}`;
      const kind = j.confidence === "high" ? "declared" : j.confidence === "medium" ? "inferred" : "corrected";
      return [
        <g key={`${t.table}.${j.column}-${j.references_table}`} className={`schema-wire schema-wire-${kind}`}>
          <path d={`M ${startX} ${startY} ${route}`} />
          <circle cx={startX} cy={startY} r={3.5} />
          <circle cx={endX} cy={endY} r={3.5} />
        </g>,
      ];
    }),
  );
  void byName;
  return (
    <figure className="discovery-schema">
      <figcaption id="discovery-schema-caption">
        <strong>
          <Icon name="network" size={17} /> Table relationship diagram
        </strong>
        <span>
          {tables.length} tables · {wires.length} {wires.length === 1 ? "join" : "joins"}
        </span>
      </figcaption>
      <div className="schema-scroll" role="region" aria-labelledby="discovery-schema-caption" tabIndex={0}>
        <div
          className="schema-canvas"
          style={{
            ["--schema-table-width" as string]: `${tableWidth}px`,
            ["--schema-header-height" as string]: `${headerHeight}px`,
            ["--schema-field-height" as string]: `${fieldHeight}px`,
            width,
            height,
          }}
        >
          <svg className="schema-wires" viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {wires}
          </svg>
          {[...placed.values()].map(({ t, x, y, fields }) => (
            <article key={t.table} className="schema-table" style={{ left: x, top: y }}>
              <header>
                <span>
                  <Icon name="table" size={13} /> {t.kind} / {t.schema}
                </span>
                <h5>{short(t.table)}</h5>
              </header>
              <ul aria-label={`${short(t.table)} fields`}>
                {fields.map((f) => (
                  <li key={f} className={linked.has(`${t.table}.${f}`) ? "is-linked" : ""}>
                    <code>{f}</code>
                    {t.keys.some((k) => short(k).toUpperCase() === f.toUpperCase()) && (
                      <span aria-label="Key" title="Key">
                        PK
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </div>
      <div className="schema-legend">
        <span className="schema-wire-declared">
          <i aria-hidden="true" /> High confidence
        </span>
        <span className="schema-wire-inferred">
          <i aria-hidden="true" /> Medium
        </span>
        <span className="schema-wire-corrected">
          <i aria-hidden="true" /> Low
        </span>
        <span className="schema-scroll-hint">
          <Icon name="arrow-right" size={13} /> Scroll to see more
        </span>
      </div>
    </figure>
  );
}

// ---------------------------------------------------------------------------------------------
// The stage
// ---------------------------------------------------------------------------------------------

export function DiscoveryStage({
  out,
  guide,
  workspaceId,
  stepId,
  can,
}: {
  out: any;
  guide: OnboardingGuide | null;
  workspaceId: string;
  stepId: string;
  can: boolean;
}) {
  const router = useRouter();
  const [section, setSection] = useState<Section>("guide");
  const [dimension, setDimension] = useState<Dimension>("tables");
  const [schemaFilter, setSchemaFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [turns, setTurns] = useState<Record<Section, AssistantTurn[]>>({ guide: [], relationships: [], gaps: [] });
  const [pending, setPending] = useState("");
  const [thinking, setThinking] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [busy, start] = useTransition();
  const lockedSections: string[] = out.locked_sections ?? [];
  const locked = lockedSections.includes(section);

  const profiles = useMemo(() => Object.fromEntries((guide?.profile.tables ?? []).map((t) => [t.table, t])), [guide]);
  const tables: TableRow[] = useMemo(
    () =>
      (out.tables as any[]).map((t) => ({
        table: t.table,
        schema: schemaOf(t.table),
        kind: t.kind,
        grain: t.grain,
        purpose: t.purpose,
        keys: t.key_columns ?? [],
        joins: t.joins ?? [],
        rows: profiles[t.table]?.rows ?? 0,
        columns: profiles[t.table]?.columns ?? [],
      })),
    [out.tables, profiles],
  );
  const schemas = [...new Set(tables.map((t) => t.schema))];
  const sum = (list: TableRow[]) => ({
    tables: list.length,
    columns: list.reduce((n, t) => n + t.columns.length, 0),
    rows: list.reduce((n, t) => n + (t.rows ?? 0), 0),
  });
  const totals = sum(tables);
  const breakdown = schemas.map((schema) => ({ schema, ...sum(tables.filter((t) => t.schema === schema)) }));
  const value = (d: Dimension, n: number) => (d === "rows" ? compact.format(n) : integer.format(n));
  const joins = tables.flatMap((t) => t.joins.map((j) => ({ from: `${short(t.table)}.${j.column}`, to: `${short(j.references_table)}.${j.references_column}`, confidence: j.confidence })));
  const gaps = (out.coverage as any[]).filter((c) => c.status !== "present");
  const issues = [...(out.quality_issues as any[])].sort((a, b) => "hml".indexOf(a.severity[0]) - "hml".indexOf(b.severity[0]));
  const visible = tables.filter(
    (t) =>
      (schemaFilter === "All" || t.schema === schemaFilter) &&
      `${t.table} ${t.kind} ${t.purpose} ${t.keys.join(" ")}`.toLowerCase().includes(search.trim().toLowerCase()),
  );

  const push = (s: Section, ...more: AssistantTurn[]) => setTurns((cur) => ({ ...cur, [s]: [...cur[s], ...more] }));

  const ask = (text: string) => {
    const s = section;
    const history = turns[s];
    push(s, { role: "user", text });
    setThinking(true);
    start(async () => {
      const res = await askWorkspaceAI(workspaceId, "discovery", text, history);
      if (res.ok && res.data) {
        const { answer, sources, grounded, unverified } = res.data;
        push(s, { role: "assistant", text: answer, check: { sources, grounded, unverified } });
      } else push(s, { role: "assistant", text: res.ok ? "No answer." : res.error });
      setThinking(false);
    });
  };

  const rerun = (text: string) => {
    const s = section;
    setPending(text);
    start(async () => {
      const res = await reviseDiscoverySection(workspaceId, stepId, s, text);
      push(
        s,
        { role: "user", text },
        {
          role: "assistant",
          text: res.ok
            ? `Updated the ${SECTIONS[s].toLowerCase()} section. The other sections were not changed. Review it before completing discovery.`
            : res.error,
        },
      );
      setPending("");
      if (res.ok) router.refresh();
    });
  };

  const toggleLock = () =>
    start(async () => {
      const res = await lockDiscoverySection(workspaceId, stepId, section, !locked);
      if (res.ok) router.refresh();
    });

  return (
    <>
      <section className="stage-panel stage-content-panel discovery-workbench">
        <PanelTitle title="Discovery review" description="Review the scan findings and correct one section at a time." icon="database" />
        <div className="discovery-semantic">
          <div>
            <strong>{guide?.profile.database ?? "Warehouse"} scanned</strong>
            <p>
              {tables.length} tables in {schemas.length} {schemas.length === 1 ? "schema" : "schemas"} · {out.cadence}
            </p>
          </div>
          <Badge>{out.coverage.filter((c: any) => c.status === "present").length} of {out.coverage.length} areas present</Badge>
        </div>
        <div className="stage-segmented discovery-sections" role="group" aria-label="Discovery sections">
          {(Object.keys(SECTIONS) as Section[]).map((key) => (
            <button key={key} type="button" aria-pressed={section === key} onClick={() => setSection(key)}>
              {SECTIONS[key]}
              {lockedSections.includes(key) && <Icon name="lock" size={13} />}
            </button>
          ))}
        </div>
        <div className={cn("lock-bar", locked && "locked")} role="group" aria-label={`${SECTIONS[section]} lock`}>
          <span className="lock-bar-icon">
            <Icon name={locked ? "lock" : "unlock"} size={20} />
          </span>
          <div className="lock-bar-text">
            <strong>
              {SECTIONS[section]}: {locked ? "Locked" : "Open for changes"}
            </strong>
            <p>
              {locked
                ? "A rerun will not change this section. Unlock it to edit it again."
                : "When this section is right, lock it so a rerun cannot change it."}
            </p>
          </div>
          {can && (
            <button type="button" className={cn("btn", locked ? "btn-secondary" : "btn-primary")} disabled={busy} onClick={toggleLock}>
              <Icon name={locked ? "unlock" : "lock"} size={17} />
              <span>{locked ? "Unlock section" : "Lock section"}</span>
            </button>
          )}
        </div>

        {section === "guide" && <FullGuide out={out} guide={guide} />}

        {section === "relationships" && (
          <div className="discovery-relationships">
            <SchemaDiagram tables={tables} />
            {joins.length ? (
              joins.map((j, i) => (
                <article key={i} className="discovery-review-item">
                  <div className="discovery-join">
                    <code>{j.from}</code>
                    <Icon name="arrow-right" size={15} />
                    <code>{j.to}</code>
                  </div>
                  <p>{cap(j.confidence)} confidence</p>
                </article>
              ))
            ) : (
              <p className="stage-helper">No relationships were found between these tables.</p>
            )}
          </div>
        )}

        {section === "gaps" && (
          <div className="discovery-gaps">
            {gaps.map((g) => (
              <article key={g.family} className="discovery-review-item">
                <div>
                  <strong>
                    {cap(words(g.family))} · {g.status}
                  </strong>
                  <p>{g.evidence}</p>
                </div>
                <Badge kind="attention">{g.status === "missing" ? "Needs clarification" : "Partly covered"}</Badge>
              </article>
            ))}
            {!gaps.length && <p className="stage-helper">Every standard area has a source.</p>}
            {issues.map((q, i) => (
              <article key={`i${i}`} className="discovery-review-item">
                <div>
                  <strong>{q.title}</strong>
                  <p>{q.evidence}</p>
                  <p>
                    Impact: {q.impact} How we handle it: {q.suggested_handling}
                  </p>
                </div>
                <Badge kind={q.severity === "high" ? "attention" : "neutral"}>{cap(q.severity)}</Badge>
              </article>
            ))}
            {(out.questions as any[]).map((q, i) => (
              <article key={`q${i}`} className="discovery-review-item">
                <div>
                  <strong>{q.question}</strong>
                  <p>
                    For {q.to}: {q.why}
                  </p>
                </div>
                {q.to === "client" && can ? (
                  <button
                    type="button"
                    className="btn btn-secondary"
                    disabled={busy || sent.has(q.question)}
                    onClick={() =>
                      start(async () => {
                        const res = await askClient(workspaceId, "discovery", q.question.slice(0, 120), `${q.question}\n\nWhy we ask: ${q.why}`);
                        if (res.ok) setSent(new Set([...sent, q.question]));
                        router.refresh();
                      })
                    }
                  >
                    <Icon name={sent.has(q.question) ? "check" : "message-square"} size={17} />
                    <span>{sent.has(q.question) ? "Sent" : "Ask customer"}</span>
                  </button>
                ) : (
                  <Badge>{q.to === "team" ? "For the team" : "For the client"}</Badge>
                )}
              </article>
            ))}
          </div>
        )}

      </section>

      <section className="stage-panel stage-content-panel source-coverage">
        <PanelTitle
          title="Source coverage"
          description="Compare the sources profiled in this scan. Select a schema to narrow the inventory below."
          icon="database"
          extra={<Badge>{schemas.length} {schemas.length === 1 ? "schema" : "schemas"}</Badge>}
        />
        <dl className="source-totals">
          {(Object.keys(DIMENSIONS) as Dimension[]).map((k) => (
            <div key={k}>
              <dt>{DIMENSIONS[k]}</dt>
              <dd title={integer.format(totals[k])}>{value(k, totals[k])}</dd>
            </div>
          ))}
        </dl>
        <div className="source-profile">
          <div className="source-profile-top">
            <h4>Profile by source</h4>
            <div className="stage-segmented" role="group" aria-label="Source breakdown">
              {(Object.keys(DIMENSIONS) as Dimension[]).map((k) => (
                <button key={k} type="button" aria-pressed={dimension === k} onClick={() => setDimension(k)}>
                  {DIMENSIONS[k]}
                </button>
              ))}
            </div>
          </div>
          <div className="source-distribution" role="img" aria-label={`${DIMENSIONS[dimension]} by schema. ${breakdown.map((b) => `${b.schema} ${integer.format(b[dimension])}`).join(", ")}`}>
            {breakdown.map((b) => (
              <span key={b.schema} style={{ ["--source-share" as string]: `${(100 * b[dimension]) / (totals[dimension] || 1)}%` }} />
            ))}
          </div>
          <div className="source-legend" role="group" aria-label="Filter tables by source">
            {breakdown.map((b) => (
              <button
                key={b.schema}
                className="source-legend-item"
                type="button"
                aria-controls="stage-table-inventory"
                aria-pressed={schemaFilter === b.schema}
                onClick={() => setSchemaFilter(schemaFilter === b.schema ? "All" : b.schema)}
              >
                <i aria-hidden="true" />
                <span>
                  <strong>{b.schema}</strong>
                  <small>{b.tables} tables</small>
                </span>
                <b title={integer.format(b[dimension])}>{value(dimension, b[dimension])}</b>
                <Icon name="chevron-right" size={15} />
              </button>
            ))}
          </div>
        </div>
      </section>

      <section className="stage-panel stage-content-panel" id="stage-table-inventory">
        <PanelTitle title="Table inventory" description="Open a table to see its key, purpose and example columns." icon="table" />
        <div className="stage-table-tools">
          <div className="stage-filters" aria-label="Filter results">
            {["All", ...schemas].map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={schemaFilter === v}
                className={`stage-filter${schemaFilter === v ? " selected" : ""}`}
                onClick={() => setSchemaFilter(v)}
              >
                {v}
              </button>
            ))}
          </div>
          <label className="stage-search">
            <Icon name="search" size={15} />
            <input type="search" aria-label="Search tables" placeholder="Search tables" value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
        </div>
        <div className="stage-table-scroll">
          <table className="stage-table">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Kind</th>
                <th scope="col">Rows</th>
                <th scope="col">Columns</th>
              </tr>
            </thead>
            <tbody>
              {visible.length ? (
                visible.map((t) => (
                  <tr key={t.table}>
                    <td>
                      <details className="stage-table-detail">
                        <summary>
                          <Icon name="table" size={16} />
                          <strong>{short(t.table)}</strong>
                          <Icon name="chevron-down" size={13} />
                        </summary>
                        <p>{t.purpose}</p>
                        <small>Key</small> <code>{t.keys.join(", ") || "none found"}</code>
                        <p>
                          <small>Example fields</small>
                          <br />
                          <code>{t.columns.slice(0, 8).map((c) => c.column).join(", ")}</code>
                        </p>
                      </details>
                    </td>
                    <td>{cap(t.kind)}</td>
                    <td className="stage-mono">{integer.format(t.rows)}</td>
                    <td className="stage-mono">{t.columns.length}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="stage-table-empty">
                    No tables match your search.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
      <section className="stage-panel stage-content-panel discovery-assistant">
        <EngineerChat
          scope={`Discovery / ${SECTIONS[section]}`}
          turns={turns[section]}
          pending={pending}
          thinking={thinking}
          emptyTitle="What would you like to review?"
          intro="Ask a follow-up about this section. You can also rerun it with a correction."
          placeholder="Ask a question or describe a correction…"
          starters={STARTERS[section]}
          rerun={
            can
              ? {
                  disabled: locked || busy,
                  locked,
                  hint: locked ? "Section locked. You can still ask questions." : "Rerunning only applies your instructions to this section.",
                }
              : null
          }
          onAsk={ask}
          onRerun={rerun}
        />
      </section>
    </>
  );
}
