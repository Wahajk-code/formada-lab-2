"use client";

import { Languages, LoaderCircle } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { translateCard } from "@/app/actions";
import type { Translation } from "@/lib/client-api";

/** On-demand translation by the translator agent, cached on the server; the translation is
 *  refused if it changes any number (ADR 0022). */
export function TranslateCard({ cardId, cardLanguage }: { cardId: string; cardLanguage: string }) {
  const t = useTranslations("translate");
  const locale = useLocale();
  const target = cardLanguage === "fr" ? "en" : "fr";
  const [result, setResult] = useState<Translation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  if (result) {
    return (
      <section className="animate-rise mx-4 mb-4 space-y-3 rounded-xl border border-border bg-card p-4" lang={result.language}>
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Languages className="size-3.5" aria-hidden /> {t("by", { agent: result.generated_by ?? "" })}
          <button type="button" onClick={() => setResult(null)} className="ml-auto underline-offset-2 hover:underline">{t("hide")}</button>
        </p>
        <h3 className="font-semibold">{result.title}</h3>
        {[["what", result.what], ["soWhat", result.so_what], ["nowWhat", result.now_what]].map(([k, v]) => (
          <p key={k} className="text-sm leading-relaxed"><span className="text-xs uppercase tracking-[0.12em] text-muted-foreground">{t(k)} · </span>{v}</p>
        ))}
      </section>
    );
  }
  return (
    <div className="mx-4 mb-4 flex flex-wrap items-center gap-2 text-xs">
      <button
        type="button"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const res = await translateCard(cardId, target);
            if (!res.ok || !res.data) return setError(res.ok ? "" : res.error);
            setResult(res.data);
          })
        }
        className="inline-flex items-center gap-1.5 rounded-full bg-surface px-3 py-1.5 text-muted-foreground transition-colors hover:text-foreground"
      >
        {pending ? <LoaderCircle className="size-3.5 animate-spin" /> : <Languages className="size-3.5" />}
        {t(target === "fr" ? "toFr" : "toEn")}
        {locale !== cardLanguage && <span className="sr-only">{t("hint")}</span>}
      </button>
      {error && <span className="text-destructive">{error}</span>}
    </div>
  );
}
