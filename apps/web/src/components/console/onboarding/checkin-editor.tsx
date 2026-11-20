"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { setCheckin } from "@/app/console-actions";
import { Icon } from "@/components/ui/icon";
import type { Checkin } from "@/lib/client-api";

const FIELD =
  "min-h-11 w-full rounded-[10px] border border-border bg-surface-strong px-[11px] text-sm font-medium outline-none focus:outline-2 focus:outline-offset-2 focus:outline-iris";

/** The next check-in the customer sees on their onboarding page (decision 6, ADR 0030). */
export function CheckinEditor({ workspaceId, checkin, can, timezone }: { workspaceId: string; checkin: Checkin | null; can: boolean; timezone: string }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const local = checkin
    ? new Date(new Date(checkin.at).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16)
    : "";
  const [at, setAt] = useState(local);
  const [lead, setLead] = useState(checkin?.lead ?? "");
  const [note, setNote] = useState(checkin?.note ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const save = (clear = false) =>
    start(async () => {
      const res = await setCheckin(workspaceId, clear || !at ? null : new Date(at).toISOString(), clear ? "" : note, clear ? "" : lead);
      setError(res.ok ? null : res.error);
      if (res.ok) {
        setEditing(false);
        router.refresh();
      }
    });
  return (
    <section className="rail-card contact-card">
      <div className="contact-label">
        <Icon name="calendar" size={17} />
        <span className="eyebrow">Next check-in</span>
      </div>
      {!editing ? (
        <>
          <h2>{checkin ? "Setup check-in" : "No check-in set"}</h2>
          <p>
            {checkin
              ? new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: timezone, timeZoneName: "short" }).format(new Date(checkin.at))
              : "The customer sees the next check-in here once you set one."}
          </p>
          {checkin?.lead && <p>With {checkin.lead}</p>}
          {can && (
            <button type="button" className="text-button" onClick={() => setEditing(true)}>
              <Icon name="pen" size={16} /> {checkin ? "Edit check-in" : "Set a check-in"}
            </button>
          )}
        </>
      ) : (
        <div className="mt-2 grid gap-2">
          <label className="stack-label">
            Date and time
            <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={FIELD} />
          </label>
          <label className="stack-label">
            Onboarding lead
            <input value={lead} onChange={(e) => setLead(e.target.value)} maxLength={200} className={FIELD} />
          </label>
          <label className="stack-label">
            Note for the customer
            <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} className={FIELD} />
          </label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary" disabled={pending || !at} onClick={() => save()}>
              Save
            </button>
            {checkin && (
              <button type="button" className="btn btn-secondary" disabled={pending} onClick={() => save(true)}>
                Clear
              </button>
            )}
            <button type="button" className="text-button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          {error && <p className="text-xs text-destructive">{error}</p>}
        </div>
      )}
    </section>
  );
}
