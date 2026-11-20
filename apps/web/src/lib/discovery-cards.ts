/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */
/** Discovery cards on the web side. The ids and the editable fields mirror the API's
 * `domain/discovery_cards.py`: the API is the authority, this only builds the same ids so a card
 * can be named in the chat and shown with its lock. */

export type CardKind = "table" | "join" | "issue" | "coverage" | "question" | "view";
export type CardSection = "guide" | "relationships" | "gaps";

export const CARD_FIELDS: Record<CardKind, string[]> = {
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
const PREFIX: Record<CardKind, string> = { table: "t", join: "j", issue: "i", coverage: "c", question: "q", view: "v" };
export const SECTION_OF: Record<CardKind, CardSection> = {
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

/** A join is named by its two ends, so it needs the table that owns it. */
export function cardId(kind: CardKind, item: any, owner = ""): string {
  if (kind === "join") return `j:${owner}.${item.column}>${item.references_table}.${item.references_column}`;
  const name =
    kind === "table" ? item.table : kind === "view" ? item.view : kind === "coverage" ? item.family : kind === "issue" ? slug(item.title ?? "") : slug(item.question ?? "");
  return `${PREFIX[kind]}:${name}`;
}

export function cardLabel(kind: CardKind, item: any, owner = ""): string {
  if (kind === "join")
    return `${owner.split(".").pop()}.${item.column} to ${String(item.references_table ?? "").split(".").pop()}.${item.references_column}`;
  if (kind === "table") return String(item.table ?? "").split(".").pop() ?? "";
  if (kind === "view") return String(item.view ?? "").split(".").pop() ?? "";
  if (kind === "coverage") return String(item.family ?? "").replace(/_/g, " ");
  if (kind === "issue") return String(item.title ?? "");
  return String(item.question ?? "").slice(0, 80);
}

export type CardRef = { id: string; kind: CardKind; label: string; locked: boolean };

/** Every card of a discovery answer, with whether it is locked (the card or its section). */
export function cardList(out: any): CardRef[] {
  const locked = new Set<string>(out.locked_cards ?? []);
  const sections = new Set<string>(out.locked_sections ?? []);
  const lists: [CardKind, any[]][] = [
    ["table", out.tables ?? []],
    ["view", out.semantic_views ?? []],
    ["issue", out.quality_issues ?? []],
    ["coverage", out.coverage ?? []],
    ["question", out.questions ?? []],
  ];
  const joins: CardRef[] = (out.tables ?? []).flatMap((t: any) =>
    (t.joins ?? []).map((j: any) => {
      const id = cardId("join", j, t.table);
      return { id, kind: "join" as const, label: cardLabel("join", j, t.table), locked: locked.has(id) || sections.has("relationships") };
    }),
  );
  return [
    ...lists.flatMap(([kind, items]) =>
      items.map((item) => {
        const id = cardId(kind, item);
        return { id, kind, label: cardLabel(kind, item), locked: locked.has(id) || sections.has(SECTION_OF[kind]) };
      }),
    ),
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
