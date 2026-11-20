"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { askTeam, goLive } from "@/app/onboarding-actions";
import { Icon } from "@/components/ui/icon";

/** The client goes live after a successful trial (ADR 0030). */
export function GoLiveButton({ ready, live }: { ready: boolean; live: boolean }) {
  const t = useTranslations("setup.live");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  if (live)
    return (
      <button type="button" className="btn btn-primary" onClick={() => router.push("/dashboard")}>
        <Icon name="rocket" size={17} />
        <span>{t("openDashboard")}</span>
      </button>
    );
  return (
    <span className="flex flex-col items-end gap-1">
      <button
        type="button"
        className="btn btn-primary"
        disabled={!ready || pending}
        onClick={() =>
          start(async () => {
            const res = await goLive();
            if (!res.ok) return setError(res.error);
            router.push("/dashboard");
          })
        }
      >
        <Icon name={pending ? "activity" : "rocket"} size={17} />
        <span>{t("goLive")}</span>
      </button>
      {error && <small className="text-xs text-destructive">{error}</small>}
    </span>
  );
}

/** "Suggest a metric": sent to the Formada team as a question on the metrics step. */
export function MetricSuggestion({ sent, can }: { sent: { text: string; at: string }[]; can: boolean }) {
  const t = useTranslations("setup.metrics");
  const locale = useLocale();
  const router = useRouter();
  const [text, setText] = useState("");
  const [pending, start] = useTransition();
  const [note, setNote] = useState<{ ok: boolean; text: string } | null>(null);
  return (
    <section className="stage-panel stage-content-panel metric-suggestion-panel">
      <div className="stage-panel-heading">
        <span className="stage-heading-icon">
          <Icon name="message-circle" size={19} />
        </span>
        <div>
          <h3>{t("suggestTitle")}</h3>
          <p>{t("suggestBody")}</p>
        </div>
      </div>
      {can && (
        <form
          className="stage-form"
          onSubmit={(e) => {
            e.preventDefault();
            const body = text.trim();
            if (!body) return;
            start(async () => {
              const res = await askTeam("metrics", t("threadTitle"), body);
              setNote(res.ok ? { ok: true, text: t("sent") } : { ok: false, text: res.error });
              if (res.ok) {
                setText("");
                router.refresh();
              }
            });
          }}
        >
          <label>
            {t("suggestLabel")}
            <textarea rows={3} maxLength={600} value={text} onChange={(e) => setText(e.target.value)} placeholder={t("suggestPlaceholder")} required />
          </label>
          <div className="stage-form-footer">
            <button type="submit" className="btn btn-secondary" disabled={pending || !text.trim()}>
              <Icon name="send" size={17} />
              <span>{t("send")}</span>
            </button>
            {note && <span className={note.ok ? "stage-helper" : "text-xs text-destructive"}>{note.text}</span>}
          </div>
        </form>
      )}
      {sent.length > 0 && (
        <ul className="metric-suggestion-list" aria-label={t("yourSuggestions")}>
          {sent.map((s) => (
            <li key={s.at}>
              <span>{s.text}</span>
              <time dateTime={s.at}>{new Date(s.at).toLocaleDateString(locale, { month: "short", day: "numeric" })}</time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
