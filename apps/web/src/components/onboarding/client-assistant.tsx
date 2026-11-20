"use client";

import { Check, LoaderCircle, Send, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { askOnboardingAI, sendSuggestions } from "@/app/onboarding-actions";
import { Button } from "@/components/ui/button";
import type { AssistantTurn, MetricIdea, RuleIdea } from "@/lib/client-api";
import { AnswerCheckLine } from "@/components/onboarding/answer-check";
import { cn } from "@/lib/utils";

const FIELD = "w-full rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";

/** The client asks the AI what to watch (metrics) or how to set rules (rules), picks the
 * suggestions they like and sends them to our team for review. */
export function ClientAssistant({ step, can }: { step: "metrics" | "rules"; can: boolean }) {
  const t = useTranslations("assistant");
  const router = useRouter();
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [q, setQ] = useState("");
  const [metrics, setMetrics] = useState<MetricIdea[]>([]);
  const [rules, setRules] = useState<RuleIdea[]>([]);
  const [chosen, setChosen] = useState<Set<number>>(new Set());
  const [note, setNote] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const ideas = step === "metrics" ? metrics : rules;

  const ask = (question: string) => {
    if (!question.trim()) return;
    const history = turns;
    setTurns([...history, { role: "user", text: question }]);
    setQ("");
    setSent(false);
    start(async () => {
      const res = await askOnboardingAI(step, question, history);
      if (res.ok && res.data) {
        setTurns((x) => [
          ...x,
          {
            role: "assistant",
            text: res.data!.answer,
            check: { sources: res.data!.sources, grounded: res.data!.grounded, unverified: res.data!.unverified },
          },
        ]);
        if (res.data.metric_suggestions.length) setMetrics(res.data.metric_suggestions);
        if (res.data.rule_suggestions.length) setRules(res.data.rule_suggestions);
        setChosen(new Set((step === "metrics" ? res.data.metric_suggestions : res.data.rule_suggestions).map((_, i) => i)));
      }
      setError(res.ok ? null : res.error);
    });
  };

  const send = () =>
    start(async () => {
      const pick = <T,>(xs: T[]) => xs.filter((_, i) => chosen.has(i));
      const res = await sendSuggestions({ step, metrics: step === "metrics" ? pick(metrics) : [], rules: step === "rules" ? pick(rules) : [], note });
      setError(res.ok ? null : res.error);
      if (res.ok) {
        setSent(true);
        router.refresh();
      }
    });

  return (
    <section className="space-y-3 rounded-2xl bg-card p-4 shadow-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4" /> {t(`${step}.title`)}
      </h3>
      <p className="text-xs text-muted-foreground">{t(`${step}.intro`)}</p>
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {[t(`${step}.starter1`), t(`${step}.starter2`)].map((s) => (
            <button key={s} type="button" disabled={!can} onClick={() => ask(s)} className="rounded-full bg-surface px-2.5 py-1 text-xs hover:bg-surface-strong">
              {s}
            </button>
          ))}
        </div>
      )}
      {turns.length > 0 && (
        <div className="max-h-80 space-y-2 overflow-y-auto pr-1">
          {turns.map((x, i) => (
            <div key={i} className={cn("node-pop whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed", x.role === "user" ? "ml-6 bg-foreground text-background" : "mr-2 bg-surface")}>
              {x.text}
              {x.check && <AnswerCheckLine check={x.check} audience="client" />}
            </div>
          ))}
          {pending && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> {t("thinking")}
            </p>
          )}
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
        className="flex gap-2"
      >
        <input value={q} onChange={(e) => setQ(e.target.value)} disabled={!can} placeholder={t(`${step}.placeholder`)} className={FIELD} />
        <Button size="sm" type="submit" disabled={!can || pending || !q.trim()}>
          <Send />
        </Button>
      </form>

      {ideas.length > 0 && (
        <div className="space-y-2 border-t border-border/60 pt-3">
          <p className="text-xs font-semibold">{t("suggestions")}</p>
          <ul className="space-y-1.5">
            {ideas.map((idea, i) => (
              <li key={i}>
                <label className={cn("flex cursor-pointer items-start gap-2 rounded-xl p-3 text-sm", chosen.has(i) ? "bg-[var(--soft-violet)] ring-1 ring-[var(--iris)]" : "bg-surface")}>
                  <input
                    type="checkbox"
                    checked={chosen.has(i)}
                    onChange={(e) => {
                      const next = new Set(chosen);
                      if (e.target.checked) next.add(i);
                      else next.delete(i);
                      setChosen(next);
                    }}
                    className="mt-1"
                  />
                  <span>
                    {"template" in idea ? (
                      <>
                        <b>{idea.name}</b>
                        <span className="block text-xs text-muted-foreground">
                          {t("for")} {idea.roles.join(", ")} · {idea.alert}
                        </span>
                      </>
                    ) : (
                      <b>
                        {idea.label}: {idea.value.toLocaleString()} {idea.unit}
                      </b>
                    )}
                    <span className="block text-xs">{idea.why}</span>
                  </span>
                </label>
              </li>
            ))}
          </ul>
          <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} placeholder={t("note")} className={FIELD} />
          <div className="flex items-center gap-2">
            <Button size="sm" disabled={!can || pending || chosen.size === 0 || sent} onClick={send}>
              {sent ? <Check /> : <Send />} {sent ? t("sent") : t("send", { n: chosen.size })}
            </Button>
            <span className="text-xs text-muted-foreground">{t("reviewNote")}</span>
          </div>
        </div>
      )}
      {error && <p className="text-xs text-[var(--critical-ink)]">{error}</p>}
    </section>
  );
}
