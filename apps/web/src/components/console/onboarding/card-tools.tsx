"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useState } from "react";

import { Icon } from "@/components/ui/icon";
import {
  CARD_FIELDS,
  ENUMS,
  FIELD_LABEL,
  LIST_FIELDS,
  type CardChangeView,
  type CardKind,
  type CardSuggestion,
  type Group,
} from "@/lib/discovery-cards";
import { cn } from "@/lib/utils";

/** Everything a card needs to be edited, locked and named in the chat. Owned by the stage. */
export type CardCtx = {
  can: boolean;
  /** Everything is locked unless its id is in here (the team unlocked it). */
  unlocked: Set<string>;
  /** The named blocks of the guide: a heading's whole set of cards, by group id. */
  groups: Record<string, Group>;
  mentioned: Set<string>;
  busy: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** The tables of the scan, for choosing the far end of a relationship. */
  tables: string[];
  onLock: (id: string, lock: boolean) => void;
  onMention: (id: string) => void;
  /** Attach the item and ask for a plain-words explanation in one step. */
  onExplain?: (id: string) => void;
  /** Returns an error message, or null when saved. */
  onSave: (id: string, fields: Record<string, unknown>) => Promise<string | null>;
  /** Relationships only. Both return an error message, or null when done. */
  onRemove: (id: string) => Promise<string | null>;
  onAddJoin: (table: string, column: string, refTable: string, refColumn: string) => Promise<string | null>;
  /** The tables of the customer's views, for choosing the ends of a link. */
  viewTables: string[];
  onAddLink: (body: { from_table: string; keys: string; to_table: string; ref_keys: string; note: string }) => Promise<string | null>;
};

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

/** The card's tools. Locked is the default and shows nothing; a card that is open for changes
 * carries an amber chip. The tools fade in when the row or card is hovered (or focused), floating
 * outside the content. The parent needs `card-hover`. */
export function CardBar({ id, ctx, join = false }: { id: string; ctx: CardCtx; join?: boolean }) {
  const open = ctx.unlocked.has(id);
  const asked = ctx.mentioned.has(id);
  return (
    <>
      {open && (
        <span className="card-open-chip" title="Open for changes. Everything else stays locked.">
          <Icon name="unlock" size={12} /> Open for changes
        </span>
      )}
      <div className={cn("card-bar card-float", ctx.editing === id && "is-pinned")} role="toolbar" aria-label="Card tools">
        {ctx.can && !open && (
          <button type="button" className="card-unlock" disabled={ctx.busy} onClick={() => ctx.onLock(id, false)}>
            <Icon name="unlock" size={14} /> Unlock
          </button>
        )}
        {ctx.can && open && (
          <>
            <button type="button" disabled={ctx.busy} onClick={() => ctx.setEditing(ctx.editing === id ? null : id)}>
              <Icon name="edit" size={14} /> Edit
            </button>
            <button type="button" className="card-lock-toggle" disabled={ctx.busy} onClick={() => ctx.onLock(id, true)}>
              <Icon name="lock" size={14} /> Lock
            </button>
            {join && (
              <button type="button" className="card-remove" disabled={ctx.busy} onClick={() => void ctx.onRemove(id)} title="Remove this relationship">
                <Icon name="trash" size={14} /> Remove
              </button>
            )}
          </>
        )}
        {ctx.onExplain && (
          <button type="button" className="card-explain" disabled={ctx.busy} onClick={() => ctx.onExplain?.(id)} title="Ask the assistant to explain this in plain words">
            <Icon name="sparkles" size={14} /> Explain
          </button>
        )}
        <button
          type="button"
          className={cn("card-at", asked && "on")}
          disabled={asked}
          onClick={() => ctx.onMention(id)}
          aria-label={asked ? "In the chat" : "Add to chat"}
          title={asked ? "In the chat" : "Add to chat as context"}
        >
          @
        </button>
      </div>
    </>
  );
}

/** The tools of a whole block (a heading): unlock or lock every card in it, or hand the whole
 * block to the chat as context. A chip says how many of its cards are open. */
export function GroupBar({ gid, ctx }: { gid: string; ctx: CardCtx }) {
  const group = ctx.groups[gid];
  if (!group) return null;
  const total = group.members.length;
  const open = group.members.filter((m) => ctx.unlocked.has(m)).length;
  const asked = ctx.mentioned.has(gid);
  return (
    <>
      {open > 0 && (
        <span className="card-open-chip" title="Cards in this block that are open for changes">
          <Icon name="unlock" size={12} /> {open === total ? `All ${total} open` : `${open} of ${total} open`}
        </span>
      )}
      <div className="card-bar card-float group-float" role="toolbar" aria-label={`${group.label}: block tools`}>
        {ctx.can && (
          <>
            <button type="button" className="card-unlock" disabled={ctx.busy || open === total} onClick={() => ctx.onLock(gid, false)}>
              <Icon name="unlock" size={14} /> Unlock all {total}
            </button>
            <button type="button" className="card-lock-toggle" disabled={ctx.busy || open === 0} onClick={() => ctx.onLock(gid, true)}>
              <Icon name="lock" size={14} /> Lock all
            </button>
          </>
        )}
        <button
          type="button"
          className={cn("card-at", asked && "on")}
          disabled={asked}
          onClick={() => ctx.onMention(gid)}
          aria-label={asked ? "In the chat" : `Add all ${total} cards to the chat`}
          title={asked ? "In the chat" : `Add this whole block (${total} cards) to the chat as context`}
        >
          @
        </button>
      </div>
    </>
  );
}

/** Edit the fields a card allows. Saving locks the card, so a rerun cannot undo the edit. */
export function CardEditor({ id, kind, item, ctx }: { id: string; kind: CardKind; item: any; ctx: CardCtx }) {
  const fields = CARD_FIELDS[kind];
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f, show(item[f])])));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const changed = fields.filter((f) => values[f] !== show(item[f]));
  const save = async () => {
    setSaving(true);
    setError(null);
    const fix = Object.fromEntries(changed.map((f) => [f, LIST_FIELDS.has(f) ? values[f] : values[f].trim()]));
    const err = await ctx.onSave(id, fix);
    setSaving(false);
    if (err) setError(err);
    else ctx.setEditing(null);
  };
  const choices = (f: string): string[] | null =>
    ENUMS[f] ?? (f === "references_table" && ctx.tables.length ? ctx.tables : f === "to_table" && ctx.viewTables.length ? ctx.viewTables : null);
  return (
    <div className="card-editor stage-form">
      <div className="card-editor-fields">
        {fields.map((f) => (
          <label key={f}>
            {FIELD_LABEL[f] ?? f}
            {choices(f) ? (
              <select value={values[f]} onChange={(e) => setValues({ ...values, [f]: e.target.value })}>
                {!choices(f)!.includes(values[f]) && <option value={values[f]}>{values[f]}</option>}
                {choices(f)!.map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
            ) : kind === "join" || (kind === "link" && f !== "note") ? (
              <input value={values[f]} maxLength={200} onChange={(e) => setValues({ ...values, [f]: e.target.value })} />
            ) : (
              <textarea rows={f === "purpose" || f === "evidence" || f === "impact" || f === "suggested_handling" ? 3 : 2} value={values[f]} maxLength={2000} onChange={(e) => setValues({ ...values, [f]: e.target.value })} />
            )}
          </label>
        ))}
      </div>
      {error && (
        <p className="stage-helper" role="alert">
          {error}
        </p>
      )}
      <div className="stage-form-footer">
        <button type="button" className="btn btn-primary" disabled={!changed.length || saving} onClick={save}>
          <Icon name="lock" size={15} /> <span>{saving ? "Saving…" : "Save and lock"}</span>
        </button>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => ctx.setEditing(null)}>
          Cancel
        </button>
        <span className="stage-helper">Saving locks this card, so a rerun cannot change it.</span>
      </div>
    </div>
  );
}

/** Declare a relationship the scan missed. It is locked, so a rerun keeps it. */
export function AddJoin({ ctx, disabled }: { ctx: CardCtx; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState({ table: "", column: "", refTable: "", refColumn: "" });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!ctx.can) return null;
  if (!open)
    return (
      <button type="button" className="btn btn-secondary add-join-open" disabled={disabled} onClick={() => setOpen(true)}>
        <Icon name="plus" size={15} /> <span>Add a relationship</span>
      </button>
    );
  const ready = v.table && v.column.trim() && v.refTable && v.refColumn.trim();
  const submit = async () => {
    setSaving(true);
    setError(null);
    const err = await ctx.onAddJoin(v.table, v.column.trim(), v.refTable, v.refColumn.trim());
    setSaving(false);
    if (err) setError(err);
    else {
      setOpen(false);
      setV({ table: "", column: "", refTable: "", refColumn: "" });
    }
  };
  const tableSelect = (key: "table" | "refTable") => (
    <select value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })}>
      <option value="">Choose a table</option>
      {ctx.tables.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
  return (
    <div className="card-editor stage-form">
      <strong>Add a relationship</strong>
      <div className="stage-fields">
        <label>
          From table
          {tableSelect("table")}
        </label>
        <label>
          Field
          <input value={v.column} maxLength={200} onChange={(e) => setV({ ...v, column: e.target.value })} />
        </label>
        <label>
          To table
          {tableSelect("refTable")}
        </label>
        <label>
          Field
          <input value={v.refColumn} maxLength={200} onChange={(e) => setV({ ...v, refColumn: e.target.value })} />
        </label>
      </div>
      {error && (
        <p className="stage-helper" role="alert">
          {error}
        </p>
      )}
      <div className="stage-form-footer">
        <button type="button" className="btn btn-primary" disabled={!ready || saving} onClick={submit}>
          <Icon name="lock" size={15} /> <span>{saving ? "Adding…" : "Add and lock"}</span>
        </button>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="stage-helper">The field names are checked against the scan.</span>
      </div>
    </div>
  );
}

/** Declare a link the customer's view is missing, with the reason. It is locked, so a rerun keeps it. */
export function AddLink({ ctx, disabled, from }: { ctx: CardCtx; disabled: boolean; from?: string }) {
  const [open, setOpen] = useState(false);
  const blank = { from_table: from ?? "", keys: "", to_table: "", ref_keys: "", note: "" };
  const [v, setV] = useState(blank);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  if (!ctx.can) return null;
  if (!open)
    return (
      <button type="button" className="btn btn-secondary add-join-open" disabled={disabled} onClick={() => setOpen(true)}>
        <Icon name="plus" size={15} /> <span>Add a missing link</span>
      </button>
    );
  const ready = v.from_table && v.keys.trim() && v.to_table && v.ref_keys.trim();
  const submit = async () => {
    setSaving(true);
    setError(null);
    const err = await ctx.onAddLink({ ...v, keys: v.keys.trim(), ref_keys: v.ref_keys.trim(), note: v.note.trim() });
    setSaving(false);
    if (err) setError(err);
    else {
      setOpen(false);
      setV(blank);
    }
  };
  const tableSelect = (key: "from_table" | "to_table") => (
    <select value={v[key]} onChange={(e) => setV({ ...v, [key]: e.target.value })}>
      <option value="">Choose a table</option>
      {ctx.viewTables.map((t) => (
        <option key={t} value={t}>
          {t}
        </option>
      ))}
    </select>
  );
  return (
    <div className="card-editor stage-form">
      <strong>Add a missing link</strong>
      <div className="stage-fields">
        <label>
          This table
          {tableSelect("from_table")}
        </label>
        <label>
          Field(s) on it
          <input value={v.keys} maxLength={200} onChange={(e) => setV({ ...v, keys: e.target.value })} />
        </label>
        <label>
          Finds its match in
          {tableSelect("to_table")}
        </label>
        <label>
          Field(s) on that table
          <input value={v.ref_keys} maxLength={200} onChange={(e) => setV({ ...v, ref_keys: e.target.value })} />
        </label>
        <label>
          Why (so the next person knows)
          <textarea rows={2} value={v.note} maxLength={2000} onChange={(e) => setV({ ...v, note: e.target.value })} />
        </label>
      </div>
      {error && (
        <p className="stage-helper" role="alert">
          {error}
        </p>
      )}
      <div className="stage-form-footer">
        <button type="button" className="btn btn-primary" disabled={!ready || saving} onClick={submit}>
          <Icon name="lock" size={15} /> <span>{saving ? "Adding…" : "Add and lock"}</span>
        </button>
        <button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setOpen(false)}>
          Cancel
        </button>
        <span className="stage-helper">Field names are checked against the view.</span>
      </div>
    </div>
  );
}

/** What the chat wants to change, as before and after, for the team to approve. */
export function ChangeReview({
  suggestion,
  applying,
  onApply,
  onDiscard,
}: {
  suggestion: CardSuggestion;
  applying: boolean;
  onApply: (picked: CardChangeView[], confirmLarge: boolean) => void;
  onDiscard: () => void;
}) {
  const key = (c: CardChangeView) => `${c.card_id}|${c.field}`;
  const [off, setOff] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState(false);
  const picked = suggestion.changes.filter((c) => !off.has(key(c)));
  const needsConfirm = suggestion.large || picked.length > 6;
  return (
    <div className="change-review" role="group" aria-label="Suggested changes">
      <strong>{suggestion.changes.length ? `Suggested changes (${suggestion.changes.length})` : "No changes suggested"}</strong>
      {suggestion.note && <p>{suggestion.note}</p>}
      <ul>
        {suggestion.changes.map((c) => (
          <li key={key(c)}>
            <label>
              <input
                type="checkbox"
                checked={!off.has(key(c))}
                onChange={(e) => {
                  const next = new Set(off);
                  if (e.target.checked) next.delete(key(c));
                  else next.add(key(c));
                  setOff(next);
                }}
              />
              <span>
                <b>{c.name}</b> · {FIELD_LABEL[c.field] ?? c.field}
              </span>
            </label>
            <div className="change-diff">
              <del>{show(c.before) || "(empty)"}</del>
              <ins>{show(c.after)}</ins>
            </div>
          </li>
        ))}
      </ul>
      {suggestion.locked.length > 0 && (
        <p className="stage-helper">
          <Icon name="lock" size={13} /> Not changed, because they are locked: {suggestion.locked.map((l) => l.card_id.split(":").slice(1).join(":")).join(", ")}.
        </p>
      )}
      {suggestion.refused.length > 0 && (
        <p className="stage-helper">Left out: {suggestion.refused.map((r) => `${r.card_id.split(":").slice(1).join(":")} (${r.reason})`).join("; ")}.</p>
      )}
      {needsConfirm && picked.length > 0 && (
        <label className="change-confirm">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>This is a large change. I have read every before and after.</span>
        </label>
      )}
      <div className="stage-form-footer">
        <button type="button" className="btn btn-primary" disabled={applying || !picked.length || (needsConfirm && !confirm)} onClick={() => onApply(picked, needsConfirm && confirm)}>
          <Icon name="check" size={15} /> <span>{applying ? "Applying…" : `Apply ${picked.length} ${picked.length === 1 ? "change" : "changes"}`}</span>
        </button>
        <button type="button" className="btn btn-secondary" disabled={applying} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
