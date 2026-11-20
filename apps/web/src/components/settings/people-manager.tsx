"use client";

import { Copy, LoaderCircle, Mail, RotateCw, UserMinus, UserPlus, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { invitePerson, removePerson, resendInvite, revokeInvite, setPersonAssignments, setPersonRole } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, Field, inputClass } from "@/components/ui/dialog";
import type { PeopleView, WorkspaceRole } from "@/lib/client-api";
import { cn } from "@/lib/utils";

type Assignment = { role_node_id: string; permission: "owner" | "viewer" };
const ROLES: WorkspaceRole[] = ["owner", "admin", "member"];

/** Pick role nodes and, for each, owner (can act on cards) or viewer (reads only). */
function AssignmentPicker({
  roles,
  value,
  onChange,
}: {
  roles: PeopleView["roles"];
  value: Assignment[];
  onChange: (v: Assignment[]) => void;
}) {
  const t = useTranslations("people");
  const byId = new Map(value.map((a) => [a.role_node_id, a.permission]));
  const set = (id: string, permission: "owner" | "viewer" | null) =>
    onChange(permission ? [...value.filter((a) => a.role_node_id !== id), { role_node_id: id, permission }] : value.filter((a) => a.role_node_id !== id));
  return (
    <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-input p-1.5">
      {roles.map((r) => {
        const p = byId.get(r.id) ?? null;
        return (
          <div key={r.id} className={cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-sm", p && "bg-surface")}>
            <span className="min-w-0 flex-1 truncate">
              {r.title}
              <span className="text-xs text-muted-foreground"> · {r.department ?? t("executive")}{r.vacant ? ` · ${t("vacant")}` : ""}</span>
            </span>
            <div className="flex rounded-md bg-card p-0.5 text-[11px] shadow-card">
              {([null, "viewer", "owner"] as const).map((opt) => (
                <button
                  key={opt ?? "none"}
                  type="button"
                  onClick={() => set(r.id, opt)}
                  aria-pressed={p === opt}
                  className={cn("rounded px-2 py-0.5 transition-colors", p === opt ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground")}
                >
                  {opt ? t(`permission.${opt}`) : t("permission.none")}
                </button>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function PeopleManager({ view }: { view: PeopleView }) {
  const t = useTranslations("people");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<{ ok: boolean; text: string; link?: string } | null>(null);
  const [inviting, setInviting] = useState(false);
  const [form, setForm] = useState({ email: "", name: "", app_role: "member" as WorkspaceRole, locale: "en" });
  const [assign, setAssign] = useState<Assignment[]>([]);
  const [editing, setEditing] = useState<PeopleView["people"][number] | null>(null);
  const [editAssign, setEditAssign] = useState<Assignment[]>([]);
  const isOwner = view.me.app_role === "owner";

  const run = (fn: () => Promise<{ ok: boolean; error?: string; data?: { link?: string } }>, done: string, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) return setMessage({ ok: false, text: res.error ?? "" });
      setMessage({ ok: true, text: done, link: res.data?.link });
      after?.();
      router.refresh();
    });

  const active = view.people.filter((p) => p.active);
  const removed = view.people.filter((p) => !p.active);
  const [filter, setFilter] = useState<"all" | "active" | "pending" | "expired">("all");
  const open = view.invites.filter((i) => i.status === "pending" || i.status === "expired");
  const vacant = view.roles.filter((r) => r.vacant).length;
  const initials = (n: string) => n.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  const tags = (list: { title: string; permission: string }[]) => (
    <div className="dw-table-roles">
      {list.map((a, i) => (
        <span key={i} className="dw-tag">
          {a.title} · {t(`permission.${a.permission}`)}
        </span>
      ))}
      {list.length === 0 && <small>{t("noRoles")}</small>}
    </div>
  );
  const showPeople = filter === "all" || filter === "active";
  const shownInvites = open.filter((i) => filter === "all" || filter === i.status);

  return (
    <div className="dw-page">
      {message && (
        <div className="dw-empty" style={{ padding: "12px 16px", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          <span style={{ flex: 1 }} className={message.ok ? undefined : "dw-quiet"}>
            {message.text}
          </span>
          {message.link && (
            <button type="button" onClick={() => navigator.clipboard.writeText(message.link!)} className="btn btn-secondary">
              <Copy className="size-3.5" /> {t("copyLink")}
            </button>
          )}
        </div>
      )}

      <section className="dw-list-shell">
        <div className="dw-section-head">
          <div>
            <h2>{t("roster")}</h2>
            <p>
              {t("rosterCount", { people: active.length, vacant })}
            </p>
          </div>
          <div className="dw-filter-row">
            <label className="dw-select">
              <span>{t("status")}</span>
              <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
                <option value="all">{t("allStatuses")}</option>
                <option value="active">{t("statusActive")}</option>
                <option value="pending">{t("inviteStatus.pending")}</option>
                <option value="expired">{t("inviteStatus.expired")}</option>
              </select>
            </label>
            <button type="button" className="btn btn-primary" onClick={() => { setInviting(true); setMessage(null); }}>
              <UserPlus className="size-4" /> {t("invite")}
            </button>
          </div>
        </div>
        <div className="dw-table-wrap" tabIndex={0} role="region" aria-label={t("roster")}>
          <table className="dw-table">
            <thead>
              <tr>
                <th scope="col">{t("person")}</th>
                <th scope="col">{t("assignedRoles")}</th>
                <th scope="col">{t("inviteStatusCol")}</th>
                <th scope="col">
                  <span className="dw-sr-only">{t("actions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {showPeople &&
                active.map((p) => (
                  <tr key={p.id}>
                    <td>
                      <div className="dw-person">
                        <span className="dw-person-avatar">{initials(p.name)}</span>
                        <div>
                          <strong>
                            {p.name} {p.is_me && <small>({t("you")})</small>}
                          </strong>
                          <small>{p.email}</small>
                        </div>
                      </div>
                    </td>
                    <td>{tags(p.assignments)}</td>
                    <td>
                      <span className="dw-tag dw-tag-positive">{t("statusActive")}</span>
                    </td>
                    <td>
                      <div className="dw-actions">
                        <select
                          value={p.app_role}
                          disabled={pending || p.is_me || (!isOwner && p.app_role === "owner")}
                          onChange={(e) => run(() => setPersonRole(p.id, e.target.value), t("roleChanged", { name: p.name }))}
                          aria-label={t("workspaceRole")}
                          className="rounded-lg border border-border bg-card px-2 py-1.5 text-xs disabled:opacity-60"
                        >
                          {ROLES.filter((r) => isOwner || r !== "owner" || p.app_role === "owner").map((r) => (
                            <option key={r} value={r}>{t(`role.${r}`)}</option>
                          ))}
                        </select>
                        <button type="button" className="dw-text-link" onClick={() => { setEditing(p); setEditAssign(p.assignments.map((a) => ({ role_node_id: a.role_node_id, permission: a.permission }))); }}>
                          {t("roles")}
                        </button>
                        {!p.is_me && (
                          <button
                            type="button"
                            className="dw-text-link"
                            disabled={pending}
                            aria-label={t("remove", { name: p.name })}
                            onClick={() => confirm(t("removeConfirm", { name: p.name })) && run(() => removePerson(p.id), t("removed", { name: p.name }))}
                          >
                            <UserMinus className="size-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              {shownInvites.map((i) => (
                <tr key={i.id}>
                  <td>
                    <div className="dw-person">
                      <span className="dw-person-avatar">
                        <Mail className="size-3.5" aria-hidden />
                      </span>
                      <div>
                        <strong>{i.name}</strong>
                        <small>{i.email}</small>
                      </div>
                    </div>
                  </td>
                  <td>{tags(i.assignments)}</td>
                  <td>
                    <span className="dw-tag">{t(`inviteStatus.${i.status}`)}</span>
                  </td>
                  <td>
                    <div className="dw-actions">
                      <button type="button" className="dw-text-link" disabled={pending} onClick={() => run(() => resendInvite(i.id), t("resent", { email: i.email }))}>
                        <RotateCw className="size-3.5" /> {t("resend")}
                      </button>
                      {i.status === "pending" && (
                        <button type="button" className="dw-text-link" disabled={pending} onClick={() => run(() => revokeInvite(i.id), t("revoked", { email: i.email }))}>
                          <X className="size-3.5" /> {t("revoke")}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!(showPeople && active.length) && !shownInvites.length && (
                <tr>
                  <td colSpan={4}>{t("noInvites")}</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {removed.length > 0 && <p className="dw-quiet">{t("removedCount", { count: removed.length })}</p>}
      </section>

      <Dialog open={inviting} onOpenChange={(o) => !pending && setInviting(o)}>
        {inviting && (
          <DialogContent title={t("inviteTitle")} description={t("inviteHint")} className="max-w-xl">
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label={t("email")}>
                <input className={inputClass} type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label={t("name")}>
                <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={t("workspaceRole")} hint={t(`roleHelp.${form.app_role}`)}>
                <select className={inputClass} value={form.app_role} onChange={(e) => setForm({ ...form, app_role: e.target.value as WorkspaceRole })}>
                  {ROLES.filter((r) => isOwner || r !== "owner").map((r) => <option key={r} value={r}>{t(`role.${r}`)}</option>)}
                </select>
              </Field>
              <Field label={t("language")}>
                <select className={inputClass} value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
                  <option value="en">English</option>
                  <option value="fr">Français</option>
                </select>
              </Field>
            </div>
            <div className="mt-4 space-y-1.5">
              <p className="text-xs font-medium">{t("assignTitle")}</p>
              <AssignmentPicker roles={view.roles} value={assign} onChange={setAssign} />
              <p className="text-xs text-muted-foreground">{t("assignHint")}</p>
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setInviting(false)} disabled={pending}>{t("cancel")}</Button>
              <Button
                size="sm"
                disabled={pending || !form.email}
                onClick={() =>
                  run(() => invitePerson({ ...form, assignments: assign }), t("sent", { email: form.email }), () => {
                    setInviting(false);
                    setForm({ email: "", name: "", app_role: "member", locale: "en" });
                    setAssign([]);
                  })
                }
              >
                {pending && <LoaderCircle className="animate-spin" />} {t("send")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(o) => !o && !pending && setEditing(null)}>
        {editing && (
          <DialogContent title={t("rolesFor", { name: editing.name })} description={t("assignHint")} className="max-w-xl">
            <AssignmentPicker roles={view.roles} value={editAssign} onChange={setEditAssign} />
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="outline" size="sm" onClick={() => setEditing(null)} disabled={pending}>{t("cancel")}</Button>
              <Button size="sm" disabled={pending} onClick={() => run(() => setPersonAssignments(editing.id, editAssign), t("saved"), () => setEditing(null))}>
                {t("save")}
              </Button>
            </div>
          </DialogContent>
        )}
      </Dialog>
    </div>
  );
}
