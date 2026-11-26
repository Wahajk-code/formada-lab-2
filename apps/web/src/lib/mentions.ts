import type { AssistantTurn } from "@/lib/client-api";

/**
 * What the chat is told about the cards, links and fields the person attached with @.
 *
 * The API reads each one and gives the AI everything it holds. As well as that, the question itself
 * names what was attached, so "change it" or "explain this" always has something to point at, even
 * if an item could not be read. An item the API could not read is reported back to the person.
 */

export type Attached = { id: string; label: string };

/** The question as the AI receives it: the person's words, then what they attached. */
export function questionWithMentions(text: string, ids: string[], labelOf: (id: string) => string | undefined): string {
  const names = ids.map((id) => labelOf(id) ?? id);
  return names.length ? `${text}

(Attached with @, this is what "it", "this" and "these" mean: ${names.join("; ")})` : text;
}

/** A line to add under an answer when some attached items could not be read. */
export function missingNote(sent: string[], missing: string[] | undefined, labelOf: (id: string) => string | undefined): string | null {
  // An older API does not report what it read: treat everything as unread rather than pretend.
  const unread = missing ?? sent;
  if (!sent.length || !unread.length) return null;
  const names = unread.map((id) => labelOf(id) ?? id).join(", ");
  return `Note: I could not read the full detail of ${names}. I answered from the question and the guide only.`;
}

// ---- what stays in the conversation's context ---------------------------------------------------


export const MAX_ATTACHED = 8;
export const CHANGE_WORD = "/change";

/** True when the message starts with the word that authorises a change. */
export const isChange = (text: string) => /^\/change(?:\s|$)/i.test(text.trim());
/**
 * True when a message reads as an order to change what is attached ("turn it to high", "use invoiced
 * sales instead"), not a question. The chat cannot change anything from a plain message, so the
 * person is offered to send it as a change instead of getting an answer that says it cannot.
 */
const CHANGE_VERBS = "change|set|make|turn|update|fix|replace|switch|use|remove|delete|add|mark|raise|lower|rename|correct|edit|revise|exclude|include|drop|keep|point|map";
export function looksLikeChange(text: string): boolean {
  const t = text.trim();
  if (!t || isChange(t) || t.endsWith("?")) return false;
  if (/^(what|why|how|can|could|does|do|is|are|should|would|which|who|when|where|explain|tell|show|list|describe|compare)/i.test(t)) return false;
  return new RegExp(`(^|[,;.:]\\s*|\\band\\s+|\\bthen\\s+)(please\\s+)?(${CHANGE_VERBS})\\b`, "i").test(t);
}
/** The message without the word. */
export const withoutChangeWord = (text: string) => text.trim().replace(/^\/change\s*/i, "").trim();

/**
 * What was attached earlier in the conversation and still counts as context: the items of the
 * person's earlier messages, newest first, once each, minus the ones they dropped. It spans every
 * page that shares the conversation, so something attached in discovery is still known in mapping.
 */
export function contextOf(turns: AssistantTurn[], dropped: string[]): { id: string; label: string }[] {
  const seen = new Set<string>(dropped);
  const found: { id: string; label: string }[] = [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    if (t.role !== "user") continue;
    for (const a of t.attached ?? []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      found.push(a);
    }
  }
  return found.slice(0, MAX_ATTACHED);
}

/** The ids sent with a question: the new attachments first, then what is still in context. */
export function idsToSend(fresh: string[], context: { id: string }[]): string[] {
  return [...new Set([...fresh, ...context.map((c) => c.id)])].slice(0, MAX_ATTACHED);
}
