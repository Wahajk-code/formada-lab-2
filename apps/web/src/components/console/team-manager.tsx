"use client";

import { LoaderCircle, UserPlus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { createStaff, updateStaff } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/dialog";
import type { StaffUser } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/** Internal team accounts (ADR 0024). Admins add people and change roles; developers read. */
export function TeamManager({ staff, meEmail, canManage }: { staff: StaffUser[]; meEmail: string; canManage: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [form, setForm] = useState({ email: "", name: "", staff_role: "developer", password: "" });
  const run = (fn: () => Promise<{ ok: boolean; error?: string }>, done: string, after?: () => void) =>
    start(async () => {
      const res = await fn();
      setMessage(res.ok ? { ok: true, text: done } : { ok: false, text: res.error ?? "Failed" });
      if (res.ok) {
        after?.();
        router.refresh();
      }
    });

  return (
    <div className="space-y-6">
      {message && <p className={cn("rounded-lg px-3 py-2 text-sm", message.ok ? "bg-surface" : "bg-brand/10 text-brand")}>{message.text}</p>}
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-card">
        {staff.map((u) => (
          <li key={u.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3", !u.active && "opacity-50")}>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-foreground">
              {u.name.split(" ").map((w) => w[0]).join("").slice(0, 2)}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{u.name} {u.email === meEmail && <span className="text-xs text-muted-foreground">(you)</span>}</p>
              <p className="text-xs text-muted-foreground">
                {u.email} · {u.last_login_at ? `last sign-in ${new Date(u.last_login_at).toLocaleDateString("en-CA")}` : "never signed in"}
                {!u.has_password && " · no password yet"}
              </p>
            </div>
            <select
              value={u.staff_role}
              disabled={!canManage || pending || u.email === meEmail}
              onChange={(e) => run(() => updateStaff(u.id, { staff_role: e.target.value }), `${u.name} is now ${e.target.value}.`)}
              aria-label={`Role of ${u.name}`}
              className="rounded-lg border border-input bg-card px-2 py-1.5 text-xs disabled:opacity-60"
            >
              <option value="admin">Admin</option>
              <option value="developer">Developer</option>
            </select>
            {canManage && u.email !== meEmail && (
              <Button size="sm" variant="outline" disabled={pending} onClick={() => run(() => updateStaff(u.id, { active: !u.active }), u.active ? `${u.name} deactivated.` : `${u.name} reactivated.`)}>
                {u.active ? "Deactivate" : "Reactivate"}
              </Button>
            )}
          </li>
        ))}
      </ul>

      {canManage ? (
        <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-card">
          <h2 className="flex items-center gap-2 text-sm font-semibold"><UserPlus className="size-4" /> Add a team member</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Email"><input className={inputClass} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
            <Field label="Name"><input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
            <Field label="Role" hint={form.staff_role === "admin" ? "Changes what clients see and pay for: rules, AI model, prompts, reviews, runs, team." : "Reads everything; drafts prompts, runs evaluations and previews; changes nothing live."}>
              <select className={inputClass} value={form.staff_role} onChange={(e) => setForm({ ...form, staff_role: e.target.value })}>
                <option value="developer">Developer</option>
                <option value="admin">Admin</option>
              </select>
            </Field>
            <Field label="Temporary password" hint="Share it privately; they change it under Your account.">
              <input className={inputClass} type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
            </Field>
          </div>
          <Button size="sm" disabled={pending || !form.email || !form.password} onClick={() => run(() => createStaff(form), `${form.email} added.`, () => setForm({ email: "", name: "", staff_role: "developer", password: "" }))}>
            {pending && <LoaderCircle className="animate-spin" />} Add
          </Button>
        </section>
      ) : (
        <p className="text-sm text-muted-foreground">Only admins add team members or change roles.</p>
      )}
    </div>
  );
}
