"use client";

import { useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";

type Labels = { current: string; next: string; confirm: string; save: string; saved: string; mismatch: string; rules: string };

/** Change password (Formada.AI design `screen-form`): the API ends every other session and hands
 * back a token for this one. */
export function PasswordForm({
  labels,
  onSave,
}: {
  labels: Labels;
  onSave: (current: string, next: string) => Promise<{ ok: true } | { ok: false; error: string }>;
}) {
  const [form, setForm] = useState({ current: "", next: "", confirm: "" });
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  return (
    <form
      className="screen-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (form.next !== form.confirm) return setMessage({ ok: false, text: labels.mismatch });
        start(async () => {
          const res = await onSave(form.current, form.next);
          setMessage(res.ok ? { ok: true, text: labels.saved } : { ok: false, text: res.error });
          if (res.ok) setForm({ current: "", next: "", confirm: "" });
        });
      }}
    >
      <label className="screen-field">
        {labels.current}
        <input type="password" autoComplete="current-password" required maxLength={128} value={form.current} onChange={(e) => setForm({ ...form, current: e.target.value })} />
      </label>
      <label className="screen-field">
        {labels.next}
        <input type="password" autoComplete="new-password" required maxLength={128} value={form.next} onChange={(e) => setForm({ ...form, next: e.target.value })} />
      </label>
      <label className="screen-field">
        {labels.confirm}
        <input type="password" autoComplete="new-password" required maxLength={128} value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} />
      </label>
      {message && (
        <p className={message.ok ? "screen-subtitle" : "screen-error"} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        <Icon name={pending ? "activity" : "check"} size={16} /> {labels.save}
      </button>
    </form>
  );
}
