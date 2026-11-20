"use client";

import { Check, KeyRound, TriangleAlert } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { useState, useSyncExternalStore, useTransition } from "react";

import { setWorkspaceLlm } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { LlmProvider, LlmSettings } from "@/lib/client-api";
import { cn } from "@/lib/utils";

const CUSTOM = "__custom__";
const noSubscribe = () => () => {};

function modelLabel(settings: LlmSettings, provider: string, model: string) {
  const p = settings.providers.find((x) => x.key === provider);
  return `${p?.models.find((m) => m.id === model)?.label ?? model} (${p?.label ?? provider})`;
}

function initialModel(p: LlmProvider, model: string) {
  return p.models.some((m) => m.id === model) ? model : CUSTOM;
}

export function LlmForm({ initial, workspaceId, can = true }: { initial: LlmSettings; workspaceId: string; can?: boolean }) {
  const t = useTranslations("settings");
  const locale = useLocale();
  const [saved, setSaved] = useState(initial);
  const [provider, setProvider] = useState(initial.provider);
  const current = saved.providers.find((p) => p.key === provider)!;
  const [choice, setChoice] = useState(initialModel(current, initial.model));
  const [custom, setCustom] = useState(choice === CUSTOM ? initial.model : "");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();

  const model = choice === CUSTOM ? custom.trim() : choice;
  const dirty = provider !== saved.provider || model !== saved.model;

  function pickProvider(p: LlmProvider) {
    setProvider(p.key);
    setChoice(p.key === saved.provider ? initialModel(p, saved.model) : p.default_model);
    setCustom(p.key === saved.provider && initialModel(p, saved.model) === CUSTOM ? saved.model : "");
    setMessage(null);
  }

  function save() {
    start(async () => {
      const res = await setWorkspaceLlm(workspaceId, provider, model);
      if (res.ok && res.data) {
        const settings = res.data as LlmSettings;
        setSaved(settings);
        setMessage({ ok: true, text: t("saved", { model: modelLabel(settings, provider, model) }) });
      } else {
        setMessage({ ok: false, text: res.ok ? "" : res.error });
      }
    });
  }

  // Browser time zone only: the server would render UTC and cause a hydration mismatch.
  const updated = useSyncExternalStore(
    noSubscribe,
    () =>
      saved.updated_at &&
      new Intl.DateTimeFormat(locale === "fr" ? "fr-CA" : "en-CA", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(saved.updated_at)),
    () => null,
  );

  return (
    <section className="animate-rise space-y-6 rounded-2xl bg-surface p-4 shadow-card sm:p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="max-w-xl space-y-1">
          <h2 className="text-lg font-semibold tracking-tight">{t("aiTitle")}</h2>
          <p className="text-sm text-muted-foreground">{t("aiHint")}</p>
        </div>
        <div className="rounded-xl bg-card px-3 py-2 text-xs shadow-card">
          <div className="font-medium uppercase tracking-[0.12em] text-muted-foreground">{t("inUse")}</div>
          <div className="mt-0.5 text-sm font-medium">{modelLabel(saved, saved.provider, saved.model)}</div>
          <div className="text-muted-foreground">
            {t(`source_${saved.source}`)}
            {updated && ` · ${t("updated", { when: updated })}`}
          </div>
        </div>
      </div>

      <fieldset className="space-y-2">
        <legend className="mb-2 text-sm font-medium">{t("provider")}</legend>
        <div role="radiogroup" className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {saved.providers.map((p) => {
            const selected = p.key === provider;
            return (
              <button
                key={p.key}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => pickProvider(p)}
                className={cn(
                  "group flex flex-col items-start gap-2 rounded-xl px-3.5 py-3 text-left transition-all duration-200",
                  selected
                    ? "bg-card shadow-card-hover ring-1 ring-foreground"
                    : "bg-surface-strong/60 hover:bg-card hover:shadow-card",
                )}
              >
                <span className="flex w-full items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.label}</span>
                  <span
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border transition-colors",
                      selected ? "border-foreground bg-foreground text-background" : "border-muted-foreground/40",
                    )}
                  >
                    {selected && <Check className="size-2.5" strokeWidth={3} aria-hidden />}
                  </span>
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1 text-xs",
                    p.configured ? "text-muted-foreground" : "font-medium text-foreground",
                  )}
                >
                  {p.configured ? (
                    <KeyRound className="size-3" aria-hidden />
                  ) : (
                    <TriangleAlert className="size-3" aria-hidden />
                  )}
                  {p.key === "fake" ? p.models[0].note : p.configured ? t("keySet") : t("keyMissing")}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {!current.configured && current.key_env && (
        <p className="animate-fade flex items-start gap-2 rounded-xl border border-dashed border-foreground/30 bg-card px-3.5 py-2.5 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{t("keyMissingHint", { env: current.key_env })}</span>
        </p>
      )}

      <fieldset>
        <legend className="mb-2 text-sm font-medium">{t("model")}</legend>
        <div role="radiogroup" className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-card">
          {[...current.models, ...(provider === "fake" ? [] : [{ id: CUSTOM, label: t("custom"), note: t("customHint") }])].map(
            (m) => {
              const selected = m.id === choice;
              return (
                <div key={m.id}>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => {
                      setChoice(m.id);
                      setMessage(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors",
                      selected ? "bg-card" : "hover:bg-surface/70",
                    )}
                  >
                    <span
                      className={cn(
                        "size-3.5 shrink-0 rounded-full border transition-all",
                        selected ? "border-[5px] border-foreground" : "border-muted-foreground/40",
                      )}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-sm font-medium">{m.label}</span>
                      {m.id !== CUSTOM && <span className="block font-mono text-xs text-muted-foreground">{m.id}</span>}
                    </span>
                    <span className="hidden text-right text-xs text-muted-foreground sm:block">{m.note}</span>
                  </button>
                  {m.id === CUSTOM && selected && (
                    <div className="animate-fade px-3.5 pb-3 pl-10">
                      <input
                        value={custom}
                        onChange={(e) => setCustom(e.target.value)}
                        placeholder={current.default_model}
                        aria-label={t("custom")}
                        autoFocus
                        className="h-9 w-full rounded-lg border border-input bg-background px-3 font-mono text-sm outline-none transition-shadow focus-visible:ring-3 focus-visible:ring-ring/30"
                      />
                    </div>
                  )}
                </div>
              );
            },
          )}
        </div>
      </fieldset>

      <div className="flex flex-wrap items-center justify-end gap-3">
        <p aria-live="polite" className="mr-auto min-h-5 text-sm">
          {message && (
            <span className={cn("animate-fade inline-flex items-center gap-1.5", !message.ok && "text-destructive")}>
              {message.ok && <Check className="size-4" aria-hidden />}
              {message.text}
            </span>
          )}
        </p>
        <Button size="lg" className="min-w-28 px-4" disabled={!can || !dirty || !model || pending} onClick={save} title={can ? undefined : "Admins only"}>
          {pending ? t("saving") : dirty ? t("save") : t("unchanged")}
        </Button>
      </div>
    </section>
  );
}
