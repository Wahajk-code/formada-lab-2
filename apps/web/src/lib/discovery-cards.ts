/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */
/** Discovery cards on the web side. The ids, the editable fields and the groups mirror the API's
 * `domain/discovery_cards.py`: the API is the authority, this only builds the same ids and blocks
 * so a card or a whole block can be named in the chat and shown with its state.
 *
 * Everything is LOCKED unless it is in `out.unlocked_cards`: the guide is mostly right, so edits
 * are targeted. */

export type CardKind = "overview" | "table" | "join" | "issue" | "coverage" | "question" | "view";
export type CardSection = "guide" | "relationships" | "gaps";

export const OVERVIEW = "o:overview";

export const CARD_FIELDS: Record<CardKind, string[]> = {
  overview: ["summary", "cadence"],
  table: ["purpose", "grain", "key_columns"],
  join: ["confidence", "column", "references_table", "references_column"],
  issue: ["severity", "evidence", "impact", "suggested_handling"],
  coverage: ["status", "evidence"],
  question: ["why", "to"],
  view: ["purpose", "grain", "caveats"],
};
export const LIST_FIELDS = new Set(["key_columns", "caveats"]);
export const ENUMS: Record<string, string[]> = {
  severity: ["high", "medium", "low"],
  status: ["present", "partial", "missing"],
  to: ["client", "team"],
  confidence: ["high", "medium", "low"],
};
export const FIELD_LABEL: Record<string, string> = {
  summary: "Bottom line",
  cadence: "How often the data is updated",
  purpose: "What it holds",
  grain: "One row is",
  key_columns: "Key fields (comma separated)",
  severity: "Severity",
  evidence: "Evidence",
  impact: "Impact",
  suggested_handling: "How we handle it",
  status: "Status",
  why: "Why it matters",
  to: "For",
  caveats: "What it cannot answer (comma separated)",
  confidence: "Confidence",
  column: "Field on the first table",
  references_table: "Joins to table",
  references_column: "Field on that table",
};
const PREFIX: Record<CardKind, string> = { overview: "o", table: "t", join: "j", issue: "i", coverage: "c", question: "q", view: "v" };
export const SECTION_OF: Record<CardKind, CardSection> = {
  overview: "guide",
  table: "guide",
  view: "guide",
  join: "relationships",
  issue: "gaps",
  coverage: "gaps",
  question: "gaps",
};

export const slug = (text: string) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);

const short = (name: unknown) => String(name ?? "").split(".").pop() ?? "";

/** A join is named by its two ends, so it needs the table that owns it. */
export function cardId(kind: CardKind, item: any, owner = ""): string {
  if (kind === "overview") return OVERVIEW;
  if (kind === "join") return `j:${owner}.${item.column}>${item.references_table}.${item.references_column}`;
  const name =
    kind === "table" ? item.table : kind === "view" ? item.view : kind === "coverage" ? item.family : kind === "issue" ? slug(item.title ?? "") : slug(item.question ?? "");
  return `${PREFIX[kind]}:${name}`;
}

export function cardLabel(kind: CardKind, item: any, owner = ""): string {
  if (kind === "overview") return "Overview";
  if (kind === "join") return `${short(owner)}.${item.column} to ${short(item.references_table)}.${item.references_column}`;
  if (kind === "table") return short(item.table);
  if (kind === "view") return short(item.view);
  if (kind === "coverage") return String(item.family ?? "").replace(/_/g, " ");
  if (kind === "issue") return String(item.title ?? "");
  return String(item.question ?? "").slice(0, 80);
}

// ---- areas and groups (blocks with a heading) ---------------------------------------------------

export type AreaKey = "sales" | "inventory" | "purchasing" | "shared";
export const AREA_KEYS: AreaKey[] = ["sales", "inventory", "purchasing", "shared"];
export const AREA_LABEL: Record<AreaKey, string> = { sales: "Sales", inventory: "Inventory", purchasing: "Purchasing", shared: "Shared lookups" };
export const AREA_FAMILIES: Record<AreaKey, string[]> = {
  sales: ["sales", "returns", "customers"],
  inventory: ["inventory", "transfers"],
  purchasing: ["purchase_orders", "receipts", "vendors"],
  shared: ["calendar"],
};
/** Purchasing and inventory are tested first, so PURCHASE_ORDERS and TRANSFER_ORDERS are not sales. */
const AREA_MATCH: [AreaKey, RegExp][] = [
  ["purchasing", /purchase|vendor|supplier|receipt|po_/i],
  ["inventory", /inventory|stock|item_?location|aggregateitem|transfer/i],
  ["sales", /sales|order|invoice|cash|customer|channel|forecast|abandon|checkout|return|wholesale|revenue/i],
];
export function areaOf(table: string): AreaKey {
  const name = short(table);
  for (const [key, rx] of AREA_MATCH) if (rx.test(name)) return key;
  return "shared";
}

export type Group = { label: string; members: string[] };

function issueAreas(tables: string[], issue: any): AreaKey[] {
  const names = new Map<string, string>();
  for (const t of tables) {
    names.set(t.toUpperCase(), t);
    names.set(short(t).toUpperCase(), t);
  }
  const hit: AreaKey[] = [];
  for (const col of issue.columns ?? []) {
    const table = String(col).split(".").slice(0, -1).join(".");
    const found = names.get(table.toUpperCase()) ?? names.get(short(table).toUpperCase());
    if (found && !hit.includes(areaOf(found))) hit.push(areaOf(found));
  }
  return hit;
}

/** Every named block of the answer: the group id is what the chat and the API use. */
export function groupIndex(out: any): Record<string, Group> {
  const found: Record<string, Group> = {};
  const add = (gid: string, label: string, members: string[]) => {
    if (members.length) found[gid] = { label, members: [...new Set(members)] };
  };
  const tables: string[] = (out.tables ?? []).map((t: any) => String(t.table ?? ""));
  const issues: any[] = out.quality_issues ?? [];
  const views = (out.semantic_views ?? []).map((v: any) => cardId("view", v));
  const questions = (out.questions ?? []).map((q: any) => cardId("question", q));
  const joinIds: string[] = (out.tables ?? []).flatMap((t: any) => (t.joins ?? []).map((j: any) => cardId("join", j, t.table)));
  const overview = "summary" in out ? [OVERVIEW] : [];
  add("g:overview", "Overview", overview);
  const placed = new Set<string>();
  for (const key of AREA_KEYS) {
    const name = AREA_LABEL[key];
    const t = tables.filter((x) => areaOf(x) === key).map((x) => cardId("table", { table: x }));
    const cov = (out.coverage ?? []).filter((c: any) => AREA_FAMILIES[key].includes(c.family)).map((c: any) => cardId("coverage", c));
    const iss = issues.filter((q) => issueAreas(tables, q).includes(key)).map((q) => cardId("issue", q));
    iss.forEach((i) => placed.add(i));
    add(`g:tables:${key}`, `${name} tables`, t);
    add(`g:coverage:${key}`, `${name} coverage`, cov);
    add(`g:issues:${key}`, `${name} data quality`, iss);
    add(`g:area:${key}`, `${name}: the whole area`, [...t, ...cov, ...iss]);
  }
  add("g:issues:general", "Data quality across areas", issues.map((q) => cardId("issue", q)).filter((i) => !placed.has(i)));
  add("g:views", "Customer semantic views", views);
  add("g:questions", "Questions for the customer", questions);
  add("g:joins", "All relationships", joinIds);
  for (const t of out.tables ?? [])
    add(`g:joins:${t.table}`, `${short(t.table)} relationships`, (t.joins ?? []).map((j: any) => cardId("join", j, t.table)));
  add("g:section:guide", "Data guide", [...overview, ...tables.map((x) => cardId("table", { table: x })), ...views]);
  add("g:section:relationships", "Relationships", joinIds);
  add("g:section:gaps", "Coverage gaps", [...(out.coverage ?? []).map((c: any) => cardId("coverage", c)), ...issues.map((q) => cardId("issue", q)), ...questions]);
  return found;
}

export type CardRef = { id: string; kind: CardKind; label: string; locked: boolean };

/** Every card of a discovery answer. A card is locked unless the team unlocked it. */
export function cardList(out: any): CardRef[] {
  const open = new Set<string>(out.unlocked_cards ?? []);
  const lists: [CardKind, any[]][] = [
    ["table", out.tables ?? []],
    ["view", out.semantic_views ?? []],
    ["issue", out.quality_issues ?? []],
    ["coverage", out.coverage ?? []],
    ["question", out.questions ?? []],
  ];
  const ref = (kind: CardKind, id: string, label: string): CardRef => ({ id, kind, label, locked: !open.has(id) });
  const joins: CardRef[] = (out.tables ?? []).flatMap((t: any) =>
    (t.joins ?? []).map((j: any) => ref("join", cardId("join", j, t.table), cardLabel("join", j, t.table))),
  );
  return [
    ...("summary" in out ? [ref("overview", OVERVIEW, "Overview")] : []),
    ...lists.flatMap(([kind, items]) => items.map((item) => ref(kind, cardId(kind, item), cardLabel(kind, item)))),
    ...joins,
  ];
}

export type CardChangeView = { card_id: string; name: string; field: string; before: unknown; after: unknown };
export type CardSuggestion = {
  changes: CardChangeView[];
  refused: { card_id: string; field: string; reason: string }[];
  locked: { card_id: string; reason: string }[];
  large: boolean;
  note: string;
};
