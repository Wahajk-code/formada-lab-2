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
  type CardSection,
  type CardSuggestion,
} from "@/lib/discovery-cards";
import { cn } from "@/lib/utils";

/** Everything a card needs to be edited, locked and named in the chat. Owned by the stage. */
export type CardCtx = {
  can: boolean;
  /** Ids locked on their own (a hand edit locks the card). */
  cardLocked: Set<string>;
  /** Sections locked as a whole: every card in them is locked. */
  sectionLocked: Set<string>;
  mentioned: Set<string>;
  busy: boolean;
  editing: string | null;
  setEditing: (id: string | null) => void;
  /** The tables of the scan, for choosing the far end of a relationship. */
  tables: string[];
  onLock: (id: string, lock: boolean) => void;
  onMention: (id: string) => void;
  /** Returns an error message, or null when saved. */
  onSave: (id: string, fields: Record<string, unknown>) => Promise<string | null>;
  /** Relationships only. Both return an error message, or null when done. */
  onRemove: (id: string) => Promise<string | null>;
  onAddJoin: (table: string, column: string, refTable: string, refColumn: string) => Promise<string | null>;
};

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

/** The card's state and tools. The lock chip is always visible; the tools fade in when the row or
 * card is hovered (or focused), floating outside the content. The parent needs `card-hover`. */
export function CardBar({ id, section, ctx, join = false }: { id: string; section: CardSection; ctx: CardCtx; join?: boolean }) {
  const bySection = ctx.sectionLocked.has(section);
  const locked = bySection || ctx.cardLocked.has(id);
  const asked = ctx.mentioned.has(id);
  return (
    <>
      {locked && (
        <span className="card-lock-chip" title={bySection ? "The whole section is locked" : "This card is locked"}>
          <Icon name="lock" size={12} /> {bySection ? "Locked with section" : "Locked"}
        </span>
      )}
      <div className={cn("card-bar card-float", ctx.editing === id && "is-pinned")} role="toolbar" aria-label="Card tools">
        {ctx.can && (
          <button type="button" disabled={locked || ctx.busy} onClick={() => ctx.setEditing(ctx.editing === id ? null : id)}>
            <Icon name="edit" size={14} /> Edit
          </button>
        )}
        {ctx.can && !bySection && (
          <button type="button" className={cn("card-lock-toggle", locked && "on")} disabled={ctx.busy} onClick={() => ctx.onLock(id, !locked)}>
            <Icon name={locked ? "unlock" : "lock"} size={14} /> {locked ? "Unlock" : "Lock"}
          </button>
        )}
        {ctx.can && join && (
          <button type="button" className="card-remove" disabled={locked || ctx.busy} onClick={() => void ctx.onRemove(id)} title="Remove this relationship">
            <Icon name="trash" size={14} /> Remove
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
    ENUMS[f] ?? (f === "references_table" && ctx.tables.length ? ctx.tables : null);
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
            ) : kind === "join" ? (
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
