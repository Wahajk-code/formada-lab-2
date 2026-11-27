"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { actionCard, type FeedbackEffect, getActionDefaults, giveFeedback } from "@/app/actions";
import { Icon } from "@/components/ui/icon";
import type { ActionDefaults } from "@/lib/client-api";

type Mode = "action" | "not_relevant" | "impossible" | null;

/** Why a card is Not relevant. Each reason means something different to the feedback loop: a wrong
 * number goes to the data team and never counts against the measure; "already handled" and "not
 * now" only close the card; the others can lead to showing the measure less often. */
const REASONS = ["already_handled", "too_small", "not_my_call", "not_now", "wrong_number", "other"] as const;
type ReasonCode = (typeof REASONS)[number];

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
  const [code, setCode] = useState<ReasonCode | null>(null);
  const [told, setTold] = useState<{ key: string; weeks: number; n: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function open(next: Mode) {
    setError(null);
    setReason("");
    setCode(null);
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
          : await giveFeedback(cardId, mode as "not_relevant" | "impossible", reason, mode === "not_relevant" ? code : null);
      if (!res.ok) return setError(res.error);
      if (mode === "action") {
        setMode(null);
        return router.refresh();
      }
      // Say what the answer does, and refresh once it has been read (the card is closed already).
      const d = (res.data ?? { suppress_days: 56, downweight_after: 3 }) as FeedbackEffect;
      const key = mode === "impossible" ? "impossible" : code === "wrong_number" ? "wrong_number" : code === "already_handled" || code === "not_now" ? "quiet" : "learn";
      setTold({ key: `effect_${key}`, weeks: Math.max(1, Math.round(d.suppress_days / 7)), n: d.downweight_after });
    });
  }

  const reasonRequired = mode === "impossible";
  const canSubmit = !pending && (mode === "action" ? defaults !== null : mode === "not_relevant" ? code !== null : !reasonRequired || reason.trim().length > 0);
  const closeMenu = (el: HTMLElement) => el.closest("details")?.removeAttribute("open");

  if (told) {
    return (
      <div className="dw-inline-form" style={{ flexBasis: "100%" }} role="status">
        <p>{t(told.key, { weeks: told.weeks, n: told.n })}</p>
        <div className="dw-actions">
          <button type="button" className="btn btn-primary" onClick={() => router.refresh()}>
            <Icon name="check" size={16} />
            {t("gotIt")}
          </button>
        </div>
      </div>
    );
  }

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
            <>
              {mode === "not_relevant" && (
                <fieldset className="dw-reasons">
                  <legend>{t("reasonPrompt")}</legend>
                  {REASONS.map((r) => (
                    <label key={r} className={code === r ? "is-on" : ""}>
                      <input type="radio" name="reason_code" value={r} checked={code === r} onChange={() => setCode(r)} />
                      {t(`reason_${r}`)}
                    </label>
                  ))}
                </fieldset>
              )}
              <label>
                {reasonRequired ? t("reasonRequired") : t("reasonOptional")}
                <input
                  maxLength={240}
                  value={reason}
                  placeholder={mode === "not_relevant" && code === "wrong_number" ? t("wrongNumberPlaceholder") : t(`${mode}Placeholder`)}
                  onChange={(e) => setReason(e.target.value)}
                  required={reasonRequired}
                />
              </label>
            </>
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
