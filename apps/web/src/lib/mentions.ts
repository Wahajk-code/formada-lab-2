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
