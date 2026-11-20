"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { updateWorkspace } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Field, inputClass } from "@/components/ui/dialog";
import type { PeopleView } from "@/lib/client-api";

const ZONES = ["America/Toronto", "America/Montreal", "America/Halifax", "America/Winnipeg", "America/Edmonton", "America/Vancouver", "America/St_Johns"];

export function WorkspaceForm({ workspace }: { workspace: PeopleView["workspace"] }) {
  const t = useTranslations("workspaceSettings");
  const router = useRouter();
  const [form, setForm] = useState(workspace);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const dirty = JSON.stringify(form) !== JSON.stringify(workspace);

  return (
    <div className="max-w-2xl space-y-4 rounded-2xl bg-card p-5 shadow-card">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label={t("name")}>
          <input className={inputClass} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label={t("locale")} hint={t("localeHint")}>
          <select className={inputClass} value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value as "en" | "fr" })}>
            <option value="en">English</option>
            <option value="fr">Français</option>
          </select>
        </Field>
        <Field label={t("timezone")} hint={t("timezoneHint")}>
          <select className={inputClass} value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
            {[...new Set([form.timezone, ...ZONES])].map((z) => <option key={z} value={z}>{z}</option>)}
          </select>
        </Field>
      </div>
      <label className="flex items-start gap-3 rounded-lg bg-surface px-3 py-2.5 text-sm">
        <input type="checkbox" className="mt-0.5 size-4" checked={form.hide_cards_from_roleless_admins} onChange={(e) => setForm({ ...form, hide_cards_from_roleless_admins: e.target.checked })} />
        <span>
          <span className="block font-medium">{t("hide")}</span>
          <span className="block text-xs text-muted-foreground">{t("hideHint")}</span>
        </span>
      </label>
      <p className="text-xs text-muted-foreground">{t("rulesNote")}</p>
      {message && <p className={message.ok ? "text-sm text-muted-foreground" : "text-sm text-destructive"}>{message.text}</p>}
      <Button
        size="sm"
        disabled={!dirty || pending}
        onClick={() =>
          start(async () => {
            const res = await updateWorkspace(form);
            setMessage(res.ok ? { ok: true, text: t("saved") } : { ok: false, text: res.error });
            if (res.ok) router.refresh();
          })
        }
      >
        {t("save")}
      </Button>
    </div>
  );
}
