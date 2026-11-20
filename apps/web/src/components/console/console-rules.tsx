"use client";

import { Ban, Check, Scale, Sparkles, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { reviewRuleAsStaff } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { ConsoleRule } from "@/lib/console-api";

/** Cross-workspace review queue: SSA staff work it during pilots (spec: Feedback loop). */
export function ConsoleRuleCard({ rule, can = true }: { rule: ConsoleRule; can?: boolean }) {
  const router = useRouter();
  const [text, setText] = useState(rule.text);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const act = (action: "accept" | "reject" | "retire") =>
    start(async () => {
      const res = await reviewRuleAsStaff(rule.workspace_id, rule.id, action, action === "accept" ? text : undefined);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  const Icon = rule.rule_type === "forbid" ? Ban : Scale;
  return (
    <article className="animate-rise space-y-3 rounded-xl bg-card p-4 shadow-card">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 font-medium text-brand-foreground">
          <Icon className="size-3" aria-hidden /> {rule.rule_type}
        </span>
        <span className="rounded-full bg-surface px-2 py-0.5 font-medium">{rule.workspace}</span>
        <span className="rounded-full bg-surface px-2 py-0.5">{rule.role}</span>
        {rule.metric && <span className="text-muted-foreground">{rule.metric}</span>}
        <span className="ml-auto text-muted-foreground">{rule.status}</span>
      </div>
      {rule.status === "proposed" ? (
        <textarea className="min-h-16 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring/30" value={text} maxLength={500} onChange={(e) => setText(e.target.value)} aria-label="Rule text" />
      ) : (
        <p className="text-sm">{rule.text}</p>
      )}
      {rule.status === "proposed" && rule.suggested_text && rule.suggested_text !== text && (
        <button type="button" onClick={() => setText(rule.suggested_text!)} className="flex w-full items-start gap-2 rounded-lg bg-brand/5 px-3 py-2 text-left text-xs transition-colors hover:bg-brand/10">
          <Sparkles className="mt-0.5 size-3.5 shrink-0 text-brand" aria-hidden />
          <span>
            <span className="font-medium text-brand">Rule drafter suggests:</span> {rule.suggested_text}
            <span className="block text-muted-foreground">Click to use this wording.</span>
          </span>
        </button>
      )}
      {rule.sources.length > 0 && (
        <ul className="space-y-1 border-l border-border pl-3 text-xs">
          {rule.sources.map((s, i) => (
            <li key={i}>
              <span className="font-medium">{s.card}</span>
              {s.reason && <span className="text-muted-foreground"> — “{s.reason}”</span>}
            </li>
          ))}
        </ul>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      {!can && rule.status !== "rejected" && rule.status !== "retired" && (
        <p className="text-xs text-muted-foreground">Admins accept, reject or retire rules.</p>
      )}
      {can && rule.status === "proposed" && (
        <div className="flex gap-2">
          <Button size="sm" onClick={() => act("accept")} disabled={pending || !text.trim()}><Check /> Accept</Button>
          <Button size="sm" variant="outline" onClick={() => act("reject")} disabled={pending}><X /> Reject</Button>
        </div>
      )}
      {can && rule.status === "active" && (
        <Button size="sm" variant="outline" onClick={() => act("retire")} disabled={pending}>Retire</Button>
      )}
    </article>
  );
}
