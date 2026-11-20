"use client";

import { Ban, Check, Scale, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { reviewRule } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { inputClass } from "@/components/ui/dialog";
import type { Rule } from "@/lib/client-api";
import { cn } from "@/lib/utils";

/** Review queue (mock screen 7): no feedback changes the agent until a person accepts its rule. */
export function RuleReview({ rules }: { rules: Rule[] }) {
  const t = useTranslations("rules");
  const proposed = rules.filter((r) => r.status === "proposed");
  const active = rules.filter((r) => r.status === "active");
  const past = rules.filter((r) => r.status === "retired" || r.status === "rejected");

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("queue", { count: proposed.length })}</h2>
        {proposed.length === 0 ? (
          <p className="rounded-xl bg-surface px-4 py-8 text-center text-sm text-muted-foreground">{t("queueEmpty")}</p>
        ) : (
          proposed.map((r) => <RuleCard key={r.id} rule={r} />)
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">{t("active", { count: active.length })}</h2>
        {active.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("activeEmpty")}</p>
        ) : (
          active.map((r) => <RuleCard key={r.id} rule={r} />)
        )}
      </section>
      {past.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm font-semibold text-muted-foreground">{t("past")}</h2>
          {past.map((r) => (
            <RuleCard key={r.id} rule={r} />
          ))}
        </section>
      )}
    </div>
  );
}

function RuleCard({ rule }: { rule: Rule }) {
  const t = useTranslations("rules");
  const router = useRouter();
  const [text, setText] = useState(rule.text);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (action: "accept" | "reject" | "retire") =>
    start(async () => {
      const res = await reviewRule(rule.id, action, action === "accept" ? text : undefined);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  const Icon = rule.rule_type === "forbid" ? Ban : Scale;

  return (
    <article
      className={cn(
        "animate-rise space-y-3 rounded-xl bg-card p-4 shadow-card",
        (rule.status === "retired" || rule.status === "rejected") && "opacity-60",
      )}
    >
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-foreground px-2 py-0.5 font-medium text-background">
          <Icon className="size-3" aria-hidden /> {t(`type.${rule.rule_type}`)}
        </span>
        <span className="rounded-full bg-surface px-2 py-0.5">{rule.role}</span>
        {rule.metric && <span className="text-muted-foreground">{rule.metric}</span>}
        <span className="ml-auto text-muted-foreground">{t(`status.${rule.status}`)}</span>
      </div>
      {rule.status === "proposed" ? (
        <textarea className={`${inputClass} min-h-16`} value={text} maxLength={500} onChange={(e) => setText(e.target.value)} aria-label={t("text")} />
      ) : (
        <p className="text-sm">{rule.text}</p>
      )}
      {rule.status === "proposed" && rule.suggested_text && rule.suggested_text !== text && (
        <button type="button" onClick={() => setText(rule.suggested_text!)} className="w-full rounded-lg bg-surface px-3 py-2 text-left text-xs transition-colors hover:bg-surface-strong">
          <span className="font-medium">{t("suggested")}</span> {rule.suggested_text}
        </button>
      )}
      <p className="text-xs text-muted-foreground">{t(`effect.${rule.rule_type}`)}</p>
      {rule.sources.length > 0 && (
        <details className="group text-xs">
          <summary className="cursor-pointer list-none text-muted-foreground hover:text-foreground">
            <span className="inline-block transition-transform group-open:rotate-90">›</span> {t("because", { count: rule.sources.length })}
          </summary>
          <ul className="mt-2 space-y-1.5 border-l border-border pl-3">
            {rule.sources.map((s, i) => (
              <li key={i}>
                <span className="font-medium">{s.card}</span>
                {s.reason && <span className="text-muted-foreground"> — “{s.reason}”</span>}
              </li>
            ))}
          </ul>
        </details>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {rule.status === "proposed" && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => act("accept")} disabled={pending || !text.trim()}>
            <Check /> {text.trim() !== rule.text ? t("acceptEdited") : t("accept")}
          </Button>
          <Button size="sm" variant="outline" onClick={() => act("reject")} disabled={pending}>
            <X /> {t("reject")}
          </Button>
        </div>
      )}
      {rule.status === "active" && (
        <Button size="sm" variant="outline" onClick={() => act("retire")} disabled={pending}>
          {t("retire")}
        </Button>
      )}
    </article>
  );
}
