"use client";

import { LoaderCircle, Send, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";

import { askWorkspaceAI } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { AssistantTurn, ThreadStep } from "@/lib/client-api";
import { AnswerCheckLine } from "@/components/onboarding/answer-check";
import { cn } from "@/lib/utils";

export const ASK_EVENT = "formada:ask-assistant";

const STARTERS: Partial<Record<ThreadStep, string[]>> = {
  discovery: ["What does the inventory table hold?", "Which issues matter most for cards?"],
  mapping: ["Which rows are excluded and why?", "Is the location split right?"],
  org: ["Which role types fit this chart?", "Why were some roles left out?"],
  metrics: ["Who should own each measure?", "Are the alert levels sensible?"],
  rules: ["Will these rules hide store problems?", "What does the money floor do?"],
  trial: ["Why did this run make these cards?", "Which problems were filtered out?"],
};

/** Ask the AI about this workspace. It knows the data guide, links, org web, measures, rules
 * and trial; never rows. The conversation lives in this page only. */
export function AssistantPanel({ workspaceId, step }: { workspaceId: string; step: ThreadStep }) {
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [q, setQ] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [turns, pending]);
  // A checklist warning's "Explain this" asks here (see review.tsx).
  const askRef = useRef<(q: string) => void>(() => {});
  useEffect(() => {
    const on = (e: Event) => {
      askRef.current((e as CustomEvent<string>).detail);
      end.current?.closest("section")?.scrollIntoView({ behavior: "smooth", block: "center" });
    };
    window.addEventListener(ASK_EVENT, on);
    return () => window.removeEventListener(ASK_EVENT, on);
  }, []);

  const ask = (question: string) => {
    if (!question.trim()) return;
    const history = turns;
    setTurns([...history, { role: "user", text: question }]);
    setQ("");
    start(async () => {
      const res = await askWorkspaceAI(workspaceId, step, question, history);
      if (res.ok && res.data) {
        const { answer, sources, grounded, unverified } = res.data;
        setTurns((t) => [...t, { role: "assistant", text: answer, check: { sources, grounded, unverified } }]);
      }
      setError(res.ok ? null : res.error);
    });
  };

  useEffect(() => {
    askRef.current = ask;
  });

  return (
    <section className="space-y-3 rounded-2xl bg-card p-4 shadow-card">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Sparkles className="size-4" /> Ask the AI about this workspace
      </h3>
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {(STARTERS[step] ?? []).map((s) => (
            <button key={s} type="button" onClick={() => ask(s)} className="rounded-full bg-surface px-2.5 py-1 text-xs hover:bg-surface-strong">
              {s}
            </button>
          ))}
        </div>
      )}
      {turns.length > 0 && (
        <div className="max-h-96 space-y-2 overflow-y-auto pr-1">
          {turns.map((t, i) => (
            <div
              key={i}
              className={cn(
                "node-pop whitespace-pre-wrap rounded-xl px-3 py-2 text-sm leading-relaxed",
                t.role === "user" ? "ml-6 bg-foreground text-background" : "mr-2 bg-surface",
              )}
            >
              {t.text}
              {t.check && <AnswerCheckLine check={t.check} audience="team" />}
            </div>
          ))}
          {pending && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <LoaderCircle className="size-3.5 animate-spin" /> Thinking…
            </p>
          )}
          <div ref={end} />
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          ask(q);
        }}
        className="flex gap-2"
      >
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. what does AUDIT_SOURCE mean?"
          className="min-w-0 flex-1 rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40"
        />
        <Button size="sm" type="submit" disabled={pending || !q.trim()}>
          <Send />
        </Button>
      </form>
      {error && <p className="text-xs text-[var(--critical-ink)]">{error}</p>}
      <p className="text-[11px] text-muted-foreground">Answers come from this workspace&apos;s onboarding only. Check before acting.</p>
    </section>
  );
}
