"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useState } from "react";

import { Icon } from "@/components/ui/icon";
import { CARD_FIELDS, ENUMS, FIELD_LABEL, LIST_FIELDS, type CardChangeView, type CardKind, type CardSuggestion } from "@/lib/discovery-cards";
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
  onLock: (id: string, lock: boolean) => void;
  onMention: (id: string) => void;
  /** Returns an error message, or null when saved. */
  onSave: (id: string, fields: Record<string, unknown>) => Promise<string | null>;
};

const show = (v: unknown) => (Array.isArray(v) ? v.join(", ") : String(v ?? ""));

/** The three things you can do to a card. A locked card shows a clear badge and cannot be edited. */
export function CardBar({ id, section, ctx }: { id: string; section: "guide" | "gaps"; ctx: CardCtx }) {
  const bySection = ctx.sectionLocked.has(section);
  const locked = bySection || ctx.cardLocked.has(id);
  const asked = ctx.mentioned.has(id);
  return (
    <div className={cn("card-bar", locked && "is-locked")}>
      {locked && (
        <span className="card-lock-badge" title={bySection ? "The whole section is locked" : "This card is locked"}>
          <Icon name="lock" size={13} /> {bySection ? "Locked with section" : "Locked"}
        </span>
      )}
      {ctx.can && (
        <>
          <button type="button" disabled={locked || ctx.busy} onClick={() => ctx.setEditing(ctx.editing === id ? null : id)}>
            <Icon name="edit" size={14} /> Edit
          </button>
          {!bySection && (
            <button type="button" className={cn("card-lock-toggle", locked && "on")} disabled={ctx.busy} onClick={() => ctx.onLock(id, !locked)}>
              <Icon name={locked ? "unlock" : "lock"} size={14} /> {locked ? "Unlock" : "Lock"}
            </button>
          )}
        </>
      )}
      <button type="button" disabled={asked} onClick={() => ctx.onMention(id)} title="Add this card to the chat as context">
        <span aria-hidden="true">@</span> {asked ? "In chat" : "Add to chat"}
      </button>
    </div>
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
  return (
    <div className="card-editor stage-form">
      <div className="card-editor-fields">
        {fields.map((f) => (
          <label key={f}>
            {FIELD_LABEL[f] ?? f}
            {ENUMS[f] ? (
              <select value={values[f]} onChange={(e) => setValues({ ...values, [f]: e.target.value })}>
                {ENUMS[f].map((o) => (
                  <option key={o} value={o}>
                    {o}
                  </option>
                ))}
              </select>
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
      <strong>
        {suggestion.changes.length ? `Suggested changes (${suggestion.changes.length})` : "No changes suggested"}
      </strong>
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
        <p className="stage-helper">
          Left out: {suggestion.refused.map((r) => `${r.card_id.split(":").slice(1).join(":")} (${r.reason})`).join("; ")}.
        </p>
      )}
      {needsConfirm && picked.length > 0 && (
        <label className="change-confirm">
          <input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
          <span>This is a large change. I have read every before and after.</span>
        </label>
      )}
      <div className="stage-form-footer">
        <button
          type="button"
          className="btn btn-primary"
          disabled={applying || !picked.length || (needsConfirm && !confirm)}
          onClick={() => onApply(picked, needsConfirm && confirm)}
        >
          <Icon name="check" size={15} /> <span>{applying ? "Applying…" : `Apply ${picked.length} ${picked.length === 1 ? "change" : "changes"}`}</span>
        </button>
        <button type="button" className="btn btn-secondary" disabled={applying} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}
