"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import {
  addDiscoveryJoin,
  applyCardChanges,
  askClient,
  askWorkspaceAI,
  editDiscoveryCard,
  lockDiscoveryCard,
  removeDiscoveryJoin,
  reviseDiscoverySection,
  suggestCardChanges,
} from "@/app/console-actions";
import { AddJoin, CardBar, CardEditor, ChangeReview, GroupBar, type CardCtx } from "@/components/console/onboarding/card-tools";
import { ChatJump } from "@/components/console/onboarding/chat-jump";
import { appendTurns, truncateTurns, useChatTurns } from "@/lib/chat-store";
import { contextOf, idsToSend, missingNote, questionWithMentions } from "@/lib/mentions";
import { cardId, cardList, groupIndex, type CardSuggestion } from "@/lib/discovery-cards";
import { EngineerChat } from "@/components/console/onboarding/engineer-chat";
import { cn } from "@/lib/utils";
import { CoverageRow, FullGuide, IssueRow, QuestionRow, ViewJoins } from "@/components/console/onboarding/full-guide";
import { fmt, humanName, makeNamer, Section, Status, Sub } from "@/components/console/onboarding/review-kit";
import { Icon, type IconName } from "@/components/ui/icon";
import type { AssistantTurn } from "@/lib/client-api";
import type { OnboardingGuide } from "@/lib/console-api";

type Section = "guide" | "relationships" | "gaps";

const SECTIONS: Record<Section, string> = { guide: "Data guide", relationships: "Relationships", gaps: "To resolve" };
const STARTERS: Record<Section, string[]> = {
  guide: ["What is the main table and why?", "Which table holds the stock counts?"],
  relationships: ["Which join needs review?", "How do the tables connect?"],
  gaps: ["Why is this area missing?", "What should we ask the customer?"],
};
const short = (t: string) => t.split(".").pop() ?? t;
const schemaOf = (t: string) => {
  const parts = t.split(".");
  return parts.length > 1 ? parts[parts.length - 2] : "SOURCE";
};
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** Split a long table name into lines that fit the card, breaking after underscores. */
function wrapName(name: string, perLine = 23): string[] {
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
/** Card header height: the kind line plus one line per wrapped name line. */
const headerFor = (lines: number) => Math.round(36 + 14.4 * lines);

function SchemaDiagram({ tables }: { tables: TableRow[] }) {
  const inset = 22;
  const tableWidth = 190;
  const columnGap = 48;
  const fieldHeight = 23;
  const rowGap = 52;
  const maxFields = 5;
  const nameLines = new Map(tables.map((t) => [t.table, wrapName(short(t.table))]));
  const headOf = (table: string) => headerFor(nameLines.get(table)?.length ?? 1);
  const headerHeight = Math.max(50, ...tables.map((t) => headOf(t.table)));
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
      const portY = (p: typeof from, f: string) => p.y + headOf(p.t.table) + fieldHeight * (p.fields.indexOf(f) + 0.5);
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
            <article
              key={t.table}
              className="schema-table"
              style={{ left: x, top: y, ["--schema-header-height" as string]: `${headOf(t.table)}px` }}
              title={t.table}
            >
              <header>
                <span>
                  <Icon name="table" size={13} /> {t.kind} / {t.schema}
                </span>
                <h5>
                  {(nameLines.get(t.table) ?? [short(t.table)]).map((line) => (
                    <span key={line}>{line}</span>
                  ))}
                </h5>
              </header>
              <ul aria-label={`${short(t.table)} fields`}>
                {fields.map((f) => (
                  <li key={f} className={linked.has(`${t.table}.${f}`) ? "is-linked" : ""}>
                    <code title={f}>{f}</code>
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

/** Measured facts the chat can be given with @ (read-only). Ids match `domain/discovery_cards.fact`. */
function factList(guide: OnboardingGuide | null): { id: string; label: string }[] {
  if (!guide) return [];
  const found: { id: string; label: string }[] = [];
  if ((guide.time_profile?.dates.length ?? 0) > 1) found.push({ id: "f:history", label: "The main table over time" });
  for (const c of guide.categories ?? [])
    if (/audit|source|origin|backfill|carried/i.test(c.column) && c.values.length > 1) found.push({ id: `f:rows:${c.column}`, label: `Where the rows come from (${c.column})` });
  const seen = new Set<string>();
  for (const v of guide.semantic_views ?? [])
    for (const t of v.tables)
      if (!seen.has(t.table)) {
        seen.add(t.table);
        found.push({ id: `f:vtable:${t.table}`, label: `${humanName(t.table)} (customer view)` });
      }
  for (const a of ["sales", "inventory", "purchasing", "shared"]) found.push({ id: `f:links:${a}`, label: `${cap(a)} links (customer views)` });
  if ((guide.key_overlaps ?? []).length) found.push({ id: "f:overlap", label: "Cross-checks between areas" });
  return found;
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
  // The conversation is saved in this browser per tab, until onboarding is done.
  const chat = useChatTurns(workspaceId);
  const [pending, setPending] = useState("");
  const [thinking, setThinking] = useState(false);
  const [sent, setSent] = useState<Set<string>>(new Set());
  const [mentioned, setMentioned] = useState<string[]>([]);
  // Attachments the person removed from the conversation's context.
  const [dropped, setDropped] = useState<string[]>([]);
  const context = useMemo(() => contextOf(chat.turns, dropped), [chat.turns, dropped]);
  const [editing, setEditing] = useState<string | null>(null);
  const [saved, setSaved] = useState<{ stepId: string; data: CardSuggestion } | null>(null);
  // A new version of the proposal (an edit, a lock, a rerun) makes an old suggestion stale.
  const suggestion = saved && saved.stepId === stepId ? saved.data : null;
  const setSuggestion = (data: CardSuggestion | null) => setSaved(data ? { stepId, data } : null);
  const [applying, setApplying] = useState(false);
  const [busy, start] = useTransition();
  const unlocked = new Set<string>(out.unlocked_cards ?? []);
  const groups = useMemo(() => groupIndex(out), [out]);
  const cardRefs = useMemo(() => cardList(out), [out]);
  // How many cards of each tab are open for changes (everything else is locked).
  const openIn = (key: Section) => (groups[`g:section:${key}`]?.members ?? []).filter((m) => unlocked.has(m)).length;
  const totalIn = (key: Section) => groups[`g:section:${key}`]?.members.length ?? 0;
  const openCount = openIn(section);
  const everythingLocked = openCount === 0;
  const facts = useMemo(() => factList(guide), [guide]);
  const mentions = mentioned.filter((id) => id in groups || cardRefs.some((c) => c.id === id) || facts.some((f) => f.id === id));
  // Measured facts can be asked about, never changed: only cards count as changes.
  const editable = mentions.filter((id) => !id.startsWith("f:"));
  const mention = (id: string) => setMentioned((cur) => (cur.includes(id) || cur.length >= 8 ? cur : [...cur, id]));
  const cards: CardCtx = {
    can,
    unlocked,
    groups,
    mentioned: new Set(mentions),
    busy,
    editing,
    setEditing,
    tables: (out.tables as any[]).map((t) => t.table),
    onLock: (id, lock) => {
      void lockDiscoveryCard(workspaceId, stepId, id, lock).then((res) => {
        if (res.ok) router.refresh();
      });
    },
    onMention: mention,
    onRemove: async (id) => {
      const res = await removeDiscoveryJoin(workspaceId, stepId, id);
      if (res.ok) router.refresh();
      return res.ok ? null : res.error;
    },
    onAddJoin: async (table, column, refTable, refColumn) => {
      const res = await addDiscoveryJoin(workspaceId, stepId, table, column, refTable, refColumn);
      if (res.ok) router.refresh();
      return res.ok ? null : res.error;
    },
    onSave: async (id, fields) => {
      const res = await editDiscoveryCard(workspaceId, stepId, id, fields);
      if (res.ok) router.refresh();
      return res.ok ? null : res.error;
    },
  };

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
  const joinCards = (out.tables as any[]).flatMap((t) =>
    (t.joins ?? []).map((item: any) => ({ id: cardId("join", item, t.table), owner: t.table as string, item })),
  );
  const gaps = (out.coverage as any[]).filter((c) => c.status !== "present");
  const issues = [...(out.quality_issues as any[])].sort((a, b) => "hml".indexOf(a.severity[0]) - "hml".indexOf(b.severity[0]));
  const nameOf = makeNamer(guide?.semantic_views);
  const tested = guide?.tested_joins ?? [];
  const testOf = (owner: string, j: any) =>
    tested.find(
      (x) =>
        x.source.toUpperCase().endsWith(`${String(owner).split(".").pop()}.${j.column}`.toUpperCase()) &&
        x.target.toUpperCase().endsWith(`${String(j.references_table).split(".").pop()}.${j.references_column}`.toUpperCase()),
    );
  const viewCount = guide?.semantic_views?.length ?? 0;
  const viewTables = new Set((guide?.semantic_views ?? []).flatMap((v) => v.tables.map((t) => String(t.base_table ?? t.table).split(".").pop()!.toUpperCase())));
  const ready = (out.coverage as any[]).filter((c) => c.status === "present").length;

  // One conversation for the whole onboarding: each message remembers the page it was written on.
  const scopeName = (s: Section) => `Discovery / ${SECTIONS[s]}`;
  const push = (s: Section, ...more: AssistantTurn[]) => appendTurns(workspaceId, scopeName(s), ...more);
  const labelFor = (id: string) => cardRefs.find((c) => c.id === id)?.label ?? facts.find((f) => f.id === id)?.label ?? groups[id]?.label;
  const attachedOf = (ids: string[]) => ids.map((id) => ({ id, label: labelFor(id) ?? id }));

  const ask = (text: string, again?: { history: AssistantTurn[]; cards: string[]; attached: { id: string; label: string }[] }) => {
    const s = section;
    const history = again?.history ?? chat.turns;
    const fresh = again?.attached ?? attachedOf(mentions);
    // The new attachments move onto this message; what was attached before stays in context.
    const cardIds = again?.cards ?? idsToSend(
      fresh.map((a) => a.id),
      context,
    );
    setDropped((d) => d.filter((x) => !fresh.some((a) => a.id === x)));
    push(s, { role: "user", text, intent: "ask", cards: cardIds, attached: fresh });
    setThinking(true);
    start(async () => {
      const label = (id: string) => labelFor(id) ?? context.find((c) => c.id === id)?.label;
      const res = await askWorkspaceAI(workspaceId, "discovery", questionWithMentions(text, cardIds, label), history, cardIds);
      if (res.ok && res.data) {
        const { answer, sources, grounded, unverified } = res.data;
        const note = missingNote(cardIds, res.data.mentions_missing, label);
        push(s, { role: "assistant", text: note ? `${answer}\n\n${note}` : answer, check: { sources, grounded, unverified } });
      } else push(s, { role: "assistant", text: res.ok ? "No answer." : res.error });
      setThinking(false);
    });
  };

  // Changes only ever touch cards, never measured facts, and the team approves each one.
  const rerun = (text: string, again?: { cards: string[]; attached?: { id: string; label: string }[] }) => {
    const s = section;
    const cardIds = (again?.cards ?? editable).filter((id) => !id.startsWith("f:") && !id.startsWith("m:"));
    const shown = again?.attached ?? attachedOf(cardIds);
    setPending(text);
    if (cardIds.length) {
      // Only the cards named with @ may change, and the team approves each change.
      start(async () => {
        const res = await suggestCardChanges(workspaceId, stepId, cardIds, text);
        push(
          s,
          { role: "user", text, intent: "suggest", cards: cardIds, attached: shown },
          {
            role: "assistant",
            text: res.ok
              ? res.data!.changes.length
                ? `I suggest ${res.data!.changes.length} ${res.data!.changes.length === 1 ? "change" : "changes"}. Nothing is saved until you apply them.`
                : "I found nothing to change on those cards."
              : res.error,
          },
        );
        if (res.ok) setSuggestion(res.data!);
        setPending("");
      });
      return;
    }
    start(async () => {
      const res = await reviseDiscoverySection(workspaceId, stepId, s, text);
      push(
        s,
        { role: "user", text, intent: "revise" },
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

  // "/change ...": the AI is authorised to propose the change, whatever it thinks of it. It acts on
  // what is attached to this message, else on what is still in the conversation's context.
  const change = (text: string) => {
    const s = section;
    const named = mentions.length ? mentions : context.map((c) => c.id);
    const target = named.filter((id) => !id.startsWith("f:") && !id.startsWith("m:"));
    const say = (reply: string) => {
      push(s, { role: "user", text: `/change ${text}`.trim(), intent: "revise", attached: attachedOf(named) }, { role: "assistant", text: reply });
    };
    if (!text) return say("Say what should change after /change, for example: /change mark receipts as ready.");
    if (!target.length && named.length) return say("What is attached cannot be changed here: facts are measured from the warehouse, and mapping links change on the Mapping step. Attach a card to change it.");
    if (!target.length && everythingLocked) return say("Everything in this tab is locked and nothing is attached, so there is nothing I may change. Unlock a card or attach one with @, then try again.");
    rerun(text, { cards: target, attached: attachedOf(target) });
  };

  // Edit a question in place: ask it again from that message on, and clear what came after it.
  const resend = (index: number, text: string) => {
    const earlier = chat.turns[index];
    if (!earlier) return;
    const history = chat.turns.slice(0, index);
    const cardIds = earlier.cards ?? [];
    truncateTurns(workspaceId, "", index);
    setSuggestion(null);
    if (earlier.intent === "suggest") rerun(text, { cards: cardIds, attached: earlier.attached });
    else ask(text, { history, cards: cardIds, attached: earlier.attached ?? [] });
  };

  const applySuggestion = (picked: CardSuggestion["changes"], confirmLarge: boolean) => {
    if (!suggestion) return;
    setApplying(true);
    void applyCardChanges(
      workspaceId,
      stepId,
      picked.map((c) => ({ card_id: c.card_id, field: c.field, value: c.after })),
      suggestion.note,
      confirmLarge,
    ).then((res) => {
      setApplying(false);
      push(section, {
        role: "assistant",
        text: res.ok ? `Applied ${picked.length} ${picked.length === 1 ? "change" : "changes"}. Review the cards, and lock the ones that are right.` : res.error,
      });
      if (res.ok) {
        setSuggestion(null);
        router.refresh();
      }
    });
  };

  const setAll = (lock: boolean) =>
    start(async () => {
      const res = await lockDiscoveryCard(workspaceId, stepId, `g:section:${section}`, lock);
      if (res.ok) router.refresh();
    });

  return (
    <>
      <section className="stage-panel stage-content-panel discovery-workbench">
        <PanelTitle title="Discovery review" description="Review the scan findings and correct one section at a time." icon="database" />
        <div className="rv-scan">
          <span className="rv-scan-db">
            <Icon name="database" size={16} />
            <b>{guide?.profile.database ?? "Warehouse"}</b>
          </span>
          {tables.length > 0 && (
            <span>
              <b>{tables.length}</b> {tables.length === 1 ? "table" : "tables"} read directly{schemas.length > 1 ? ` in ${schemas.length} schemas` : ""}
            </span>
          )}
          {viewCount > 0 && (
            <span>
              <b>{viewCount}</b> customer {viewCount === 1 ? "view" : "views"}
              {viewTables.size > 0 && ` with ${viewTables.size} tables`}
            </span>
          )}
          <span>
            <b>{ready}</b> of {out.coverage.length} kinds of data ready
          </span>
        </div>
        <div className="stage-segmented discovery-sections" role="group" aria-label="Discovery sections">
          {(Object.keys(SECTIONS) as Section[]).map((key) => (
            <button key={key} type="button" aria-pressed={section === key} onClick={() => setSection(key)}>
              {SECTIONS[key]}
              {openIn(key) > 0 && (
                <span className="tab-open" title={`${openIn(key)} cards open for changes`}>
                  {openIn(key)}
                </span>
              )}
            </button>
          ))}
        </div>
        <div className={cn("lock-bar", everythingLocked ? "locked" : "open")} role="group" aria-label={`${SECTIONS[section]} locks`}>
          <span className="lock-bar-icon">
            <Icon name={everythingLocked ? "lock" : "unlock"} size={20} />
          </span>
          <div className="lock-bar-text">
            <strong>
              {everythingLocked
                ? `${SECTIONS[section]}: everything is locked`
                : `${SECTIONS[section]}: ${openCount} of ${totalIn(section)} cards open for changes`}
            </strong>
            <p>
              {everythingLocked
                ? "Unlock only the cards you want to change. Hover a row, a card or a heading for its tools."
                : "Everything else stays locked, even when you rerun or ask the chat to change things."}
            </p>
          </div>
          {can && totalIn(section) > 0 && (
            <div className="lock-bar-actions">
              <button type="button" className="btn btn-secondary" disabled={busy || openCount === totalIn(section)} onClick={() => setAll(false)}>
                <Icon name="unlock" size={16} />
                <span>Unlock all</span>
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy || everythingLocked} onClick={() => setAll(true)}>
                <Icon name="lock" size={16} />
                <span>Lock all</span>
              </button>
            </div>
          )}
        </div>

        {section === "guide" && <FullGuide out={out} guide={guide} cards={cards} onResolve={() => setSection("gaps")} />}

        {section === "relationships" && (
          <div className="rv">
            <ViewJoins guide={guide} cards={cards} />
            <SchemaDiagram tables={tables} />
            <Section icon="network" title="How the directly-read tables join" point="Tables we read straight from the warehouse, not through a view. Mapping uses these joins to add names, locations and dates to every row. A wrong join gives wrong numbers, so check the low ones first.">
              {joinCards.length ? (
                (out.tables as any[])
                  .filter((t) => (t.joins ?? []).length)
                  .map((t) => (
                    <div key={t.table} className="rv-block">
                      <Sub title={nameOf(t.table)} note={`${t.joins.length} ${t.joins.length === 1 ? "join" : "joins"}`} tools={<GroupBar gid={`g:joins:${t.table}`} ctx={cards} />} />
                      <div className="rv-items">
                        {(t.joins as any[]).map((item) => {
                          const id = cardId("join", item, t.table);
                          const test = testOf(t.table, item);
                          const conf = item.confidence === "high" ? "ready" : item.confidence === "low" ? "fail" : "partial";
                          return (
                            <article key={id} className={cn("rv-item rv-join card-hover", unlocked.has(id) && "is-open")}>
                              <div className="rv-join-ends">
                                <span>
                                  <b>{nameOf(t.table)}</b>
                                  <code>{item.column}</code>
                                </span>
                                <Icon name="arrow-right" size={16} />
                                <span>
                                  <b>{nameOf(item.references_table)}</b>
                                  <code>{item.references_column}</code>
                                </span>
                              </div>
                              <div className="rv-join-facts">
                                <Status tone={conf}>{cap(item.confidence)} confidence</Status>
                                {test?.matched_pct != null ? (
                                  <span className={cn("rv-fill", test.matched_pct < 90 && "low")} title="Share of values on the first table that find a match">
                                    <i style={{ ["--p" as string]: `${test.matched_pct}%` }} />
                                    {Math.round(test.matched_pct)}% of values match
                                    {test.orphan_values ? ` · ${fmt.plural(test.orphan_values, "value")} without a match` : ""}
                                  </span>
                                ) : (
                                  <span className="rv-muted">Not tested on the data</span>
                                )}
                              </div>
                              <CardBar id={id} ctx={cards} join />
                              {editing === id && <CardEditor key={id} id={id} kind="join" item={item} ctx={cards} />}
                            </article>
                          );
                        })}
                      </div>
                    </div>
                  ))
              ) : (
                <p className="stage-helper">No joins between directly-read tables.</p>
              )}
              <AddJoin ctx={cards} disabled={busy} />
            </Section>
          </div>
        )}

        {section === "gaps" && (
          <div className="rv">
            <Section
              icon="message-square"
              title="Questions"
              count={out.questions.length}
              point="Answers we need before mapping can be trusted. Send the customer's questions from here; they reply in the customer app."
              tools={<GroupBar gid="g:questions" ctx={cards} />}
            >
              <div className="rv-items">
                {(out.questions as any[]).map((q) => (
                  <QuestionRow
                    key={q.question}
                    q={q}
                    ctx={cards}
                    action={
                      q.to === "client" && can ? (
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
                          <Icon name={sent.has(q.question) ? "check" : "send"} size={16} />
                          <span>{sent.has(q.question) ? "Sent" : "Send to the customer"}</span>
                        </button>
                      ) : undefined
                    }
                  />
                ))}
                {!out.questions.length && <p className="stage-helper">No open questions.</p>}
              </div>
            </Section>
            <Section icon="target" title="Data we do not fully have" count={gaps.length} point="Kinds of data that are only partly there or not found. Metrics that need them stay off until they are resolved.">
              {gaps.length ? (
                <ul className="rv-covs">
                  {gaps.map((g) => (
                    <CoverageRow key={g.family} c={g} ctx={cards} />
                  ))}
                </ul>
              ) : (
                <p className="stage-helper">Every kind of data has a source.</p>
              )}
            </Section>
            <Section
              icon="danger-circle"
              title="Issues that change the numbers"
              count={issues.filter((q) => q.severity !== "low").length}
              point="High and medium data issues, each with how mapping handles it. Check the handling is right."
            >
              <div className="rv-items">
                {issues
                  .filter((q) => q.severity !== "low")
                  .map((q) => (
                    <IssueRow key={q.title} q={q} ctx={cards} />
                  ))}
              </div>
              {issues.some((q) => q.severity === "low") && (
                <p className="stage-helper">{issues.filter((q) => q.severity === "low").length} low issues are in the data guide, under their area.</p>
              )}
            </Section>
          </div>
        )}
      </section>

      <section className="stage-panel stage-content-panel discovery-assistant">
        <EngineerChat
          scope={`Discovery / ${SECTIONS[section]}`}
          turns={chat.turns}
          onClear={chat.clear}
          onResend={resend}
          pending={pending}
          thinking={thinking}
          emptyTitle="What would you like to review?"
          intro="Ask a follow-up about this section. You can also rerun it with a correction."
          placeholder="Ask a question or describe a correction…"
          starters={STARTERS[section]}
          rerun={
            can
              ? {
                  disabled: busy || (!editable.length && everythingLocked),
                  locked: !editable.length && everythingLocked,
                  label: editable.length ? `Suggest changes to ${editable.length} ${editable.length === 1 ? "mention" : "mentions"}` : undefined,
                  hint: editable.length
                    ? "Only the cards you mention can change, and only the unlocked ones. You approve every change."
                    : everythingLocked
                      ? "Everything in this tab is locked. You can still ask questions."
                      : `A rerun changes only the ${openCount} open ${openCount === 1 ? "card" : "cards"}. Mention cards or blocks with @ to change only those.`,
                }
              : null
          }
          mentionables={[
            ...Object.entries(groups)
              .filter(([gid]) => !gid.startsWith("g:section:"))
              .map(([gid, g]) => ({ id: gid, label: `${g.label} (${g.members.length})`, kind: "block", locked: !g.members.some((m) => unlocked.has(m)) })),
            ...cardRefs.map((c) => ({ id: c.id, label: c.label, kind: c.kind, locked: c.locked })),
            ...facts.map((f) => ({ id: f.id, label: f.label, kind: "fact", locked: false, note: "Measured from the warehouse: read-only" })),
          ]}
          mentions={mentions}
          onMentions={setMentioned}
          extra={suggestion ? <ChangeReview suggestion={suggestion} applying={applying} onApply={applySuggestion} onDiscard={() => setSuggestion(null)} /> : undefined}
          onAsk={(text) => ask(text)}
          onRerun={rerun}
          onChange={change}
          context={context}
          onDropContext={(id) => setDropped((d) => [...d, id])}
        />
      </section>
      <ChatJump count={mentions.length} />
    </>
  );
}
