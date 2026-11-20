"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { actionCard, getActionDefaults, giveFeedback } from "@/app/actions";
import { Icon } from "@/components/ui/icon";
import type { ActionDefaults } from "@/lib/client-api";

type Mode = "action" | "not_relevant" | "impossible" | null;

/** Action this, and Feedback (Not relevant, Impossible), in the Formada.AI design: the buttons
 * sit in the card footer and the form opens inline below them. Both forms are prefilled so
 * actioning is one click and flagging is one sentence. */
export function CardActions({ cardId, cardTitle, own = true }: { cardId: string; cardTitle: string; own?: boolean }) {
  const t = useTranslations("actions");
  const router = useRouter();
  const [mode, setMode] = useState<Mode>(null);
  const [defaults, setDefaults] = useState<ActionDefaults | null>(null);
  const [form, setForm] = useState({ baseline: "", period: "", window: "", target: "", due: "" });
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function open(next: Mode) {
    setError(null);
    setReason("");
    setMode(next);
    if (next === "action") {
      start(async () => {
        const res = await getActionDefaults(cardId);
        if (!res.ok || !res.data) return setError(res.ok ? t("failed") : res.error);
        const d = res.data;
        setDefaults(d);
        setForm({ baseline: String(d.baseline_value), period: d.baseline_period, window: String(d.window_days), target: "", due: "" });
      });
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    start(async () => {
      const res =
        mode === "action"
          ? await actionCard(cardId, {
              baseline_value: form.baseline === "" ? null : Number(form.baseline),
              baseline_period: form.period || null,
              window_days: form.window === "" ? null : Number(form.window),
              target_value: form.target === "" ? null : Number(form.target),
              due_date: form.due || null,
            })
          : await giveFeedback(cardId, mode as "not_relevant" | "impossible", reason);
      if (!res.ok) return setError(res.error);
      setMode(null);
      router.refresh();
    });
  }

  const reasonRequired = mode === "impossible";
  const canSubmit = !pending && (mode === "action" ? defaults !== null : !reasonRequired || reason.trim().length > 0);
  const closeMenu = (el: HTMLElement) => el.closest("details")?.removeAttribute("open");

  return (
    <>
      <button type="button" className="btn btn-primary" onClick={() => open("action")}>
        <Icon name="arrow-right" size={16} />
        {t("action")}
      </button>
      {own && (
        <details className="dw-feedback-menu">
          <summary aria-label={`${t("feedback")}: ${cardTitle}`}>
            {t("feedback")} <Icon name="chevron-down" size={14} />
          </summary>
          <div>
            <button
              type="button"
              className="dw-menu-button"
              onClick={(e) => {
                closeMenu(e.currentTarget);
                open("not_relevant");
              }}
            >
              {t("notRelevant")}
            </button>
            <button
              type="button"
              className="dw-menu-button"
              onClick={(e) => {
                closeMenu(e.currentTarget);
                open("impossible");
              }}
            >
              {t("impossible")}
            </button>
          </div>
        </details>
      )}
      {mode && (
        <form className="dw-inline-form" style={{ flexBasis: "100%" }} onSubmit={submit}>
          <div>
            <h4>{t(`${mode}Title`)}</h4>
            <p>{t(`${mode}Hint`)}</p>
          </div>
          {mode === "action" ? (
            defaults ? (
              <div className="dw-fields">
                <label>
                  {t("baseline", { unit: defaults.unit })}
                  <input inputMode="decimal" value={form.baseline} onChange={(e) => setForm({ ...form, baseline: e.target.value })} required />
                </label>
                <label>
                  {t("period")}
                  <input value={form.period} maxLength={80} onChange={(e) => setForm({ ...form, period: e.target.value })} required />
                </label>
                <label>
                  {t("window")}
                  <input
                    type="number"
                    min={defaults.min_window_days}
                    max={defaults.max_window_days}
                    value={form.window}
                    onChange={(e) => setForm({ ...form, window: e.target.value })}
                    required
                  />
                </label>
                <label>
                  {t("target", { unit: defaults.unit })} ({t("optional").toLowerCase()})
                  <input inputMode="decimal" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} />
                </label>
                <label>
                  {t("due")} ({t("optional").toLowerCase()})
                  <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
                </label>
              </div>
            ) : (
              <p className="dw-quiet">{t("loading")}</p>
            )
          ) : (
            <label>
              {reasonRequired ? t("reasonRequired") : t("reasonOptional")}
              <input maxLength={240} value={reason} placeholder={t(`${mode}Placeholder`)} onChange={(e) => setReason(e.target.value)} required={reasonRequired} />
            </label>
          )}
          {error && (
            <p className="dw-quiet" role="alert">
              {error}
            </p>
          )}
          <div className="dw-actions">
            <button type="button" className="btn btn-secondary" onClick={() => setMode(null)} disabled={pending}>
              {t("cancel")}
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
              <Icon name="check" size={16} />
              {t(`${mode}Confirm`)}
            </button>
          </div>
        </form>
      )}
    </>
  );
}
