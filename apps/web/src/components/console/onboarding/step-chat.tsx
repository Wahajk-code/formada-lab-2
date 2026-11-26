"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";

import { askWorkspaceAI, loadRun, reviseProposalItem } from "@/app/console-actions";
import { ChatJump } from "@/components/console/onboarding/chat-jump";
import { EngineerChat } from "@/components/console/onboarding/engineer-chat";
import type { AssistantTurn } from "@/lib/client-api";
import { appendTurns, truncateTurns, useChatTurns } from "@/lib/chat-store";
import type { OnboardingStep } from "@/lib/console-api";
import { contextOf, idsToSend, missingNote, questionWithMentions } from "@/lib/mentions";

/**
 * The chat for the Org Web and Metrics steps: the same conversation as Discovery and Mapping, with the
 * roles or measures of the proposal attached by @. Ask, or start with /change to have the AI change the
 * attached item (only that item changes, it is saved as a new proposal, and you see the result).
 */

const KIND = {
  org: { prefix: "r:", item: "role", items: "roles", scope: "Org Web" },
  metrics: { prefix: "x:", item: "measure", items: "measures", scope: "Metrics" },
  trial: { prefix: "k:", item: "card", items: "cards", scope: "Trial run" },
  connect: { prefix: "v:", item: "view", items: "views", scope: "Connect" },
} as const;

export function StepChat({
  workspaceId,
  stepName,
  step,
  can,
  starters,
  runId,
}: {
  workspaceId: string;
  stepName: "org" | "metrics" | "trial" | "connect";
  step?: OnboardingStep | undefined;
  can: boolean;
  starters: string[];
  /** Trial only: the run whose cards can be attached. */
  runId?: string | null;
}) {
  const router = useRouter();
  const kind = KIND[stepName];
  const out = step?.output as any;
  const { turns, clear } = useChatTurns(workspaceId);
  const [thinking, setThinking] = useState(false);
  const [, start] = useTransition();
  const [mentioned, setMentioned] = useState<string[]>([]);
  const [dropped, setDropped] = useState<string[]>([]);
  const context = useMemo(() => contextOf(turns, dropped), [turns, dropped]);
  // The trial's cards, so a card can be attached and asked about.
  const [trialCards, setTrialCards] = useState<{ id: string; role: string; title: string }[]>([]);
  useEffect(() => {
    if (stepName !== "trial" || !runId) return;
    let stop = false;
    void loadRun(workspaceId, runId).then((res) => {
      if (!stop && res.ok && res.data) setTrialCards(res.data.cards.map((c) => ({ id: c.id, role: c.role, title: c.title })));
    });
    return () => {
      stop = true;
    };
  }, [stepName, runId, workspaceId]);

  const mentionables = useMemo(
    () =>
      stepName === "org"
        ? ((out?.roles ?? []) as any[]).map((r) => ({ id: `r:${r.ref}`, label: String(r.title), kind: "role", locked: false, note: "Given to the chat as context" }))
        : stepName === "metrics"
          ? ((out?.metrics ?? []) as any[]).map((m) => ({ id: `x:${m.key}`, label: String(m.name ?? m.key), kind: "measure", locked: false, note: "Given to the chat as context" }))
          : stepName === "connect"
            ? []
            : trialCards.map((c) => ({ id: `k:${c.id}`, label: `${c.role}: ${c.title}`, kind: "card", locked: false, note: "Given to the chat as context" })),
    [out, stepName, trialCards],
  );
  const mentions = mentioned.filter((id) => mentionables.some((m) => m.id === id));
  const labelFor = (id: string) => mentionables.find((m) => m.id === id)?.label ?? context.find((c) => c.id === id)?.label;
  const attachedOf = (ids: string[]) => ids.map((id) => ({ id, label: labelFor(id) ?? id }));
  const push = (...more: AssistantTurn[]) => appendTurns(workspaceId, kind.scope, ...more);

  const ask = (text: string, earlier?: { history: AssistantTurn[]; cards: string[]; attached: { id: string; label: string }[] }) => {
    const history = earlier?.history ?? turns;
    const fresh = earlier?.attached ?? attachedOf(mentions);
    const cards = earlier?.cards ?? idsToSend(fresh.map((a) => a.id), context);
    setDropped((d) => d.filter((x) => !fresh.some((a) => a.id === x)));
    push({ role: "user", text, intent: "ask", cards, attached: fresh });
    setThinking(true);
    start(async () => {
      const res = await askWorkspaceAI(workspaceId, stepName, questionWithMentions(text, cards, labelFor), history, cards);
      if (res.ok && res.data) {
        const { answer, sources, grounded, unverified } = res.data;
        const note = missingNote(cards, res.data.mentions_missing, labelFor);
        push({ role: "assistant", text: note ? `${answer}\n\n${note}` : answer, check: { sources, grounded, unverified } });
      } else push({ role: "assistant", text: res.ok ? "No answer." : res.error });
      setThinking(false);
    });
  };

  // "/change ...": the AI changes the attached role or measure, whatever it thinks of the change. It is a
  // new proposal of that one item.
  const change = (text: string) => {
    const named = mentions.length ? mentions : context.map((c) => c.id);
    const mine = named.filter((id) => id.startsWith(kind.prefix));
    const say = (reply: string) => push({ role: "user", text: `/change ${text}`.trim(), intent: "revise", attached: attachedOf(named) }, { role: "assistant", text: reply });
    if (!text) return say(`Say what should change after /change, for example: /change ${stepName === "org" ? "rename this role to Senior Buyer" : "alert at 25 days"}.`);
    if (!step || !can) return say("This step cannot be changed right now: it is already complete, or it has not been proposed yet.");
    if (!mine.length) return say(`Attach the ${kind.item} you want changed with @, then start again with /change.`);
    const keys = mine.map((id) => id.slice(2)).slice(0, 2);
    setThinking(true);
    start(async () => {
      const done: string[] = [];
      let failed: string | null = null;
      for (const key of keys) {
        const res = await reviseProposalItem(workspaceId, stepName, step.id, key, text);
        if (!res.ok) {
          failed = res.error ?? "Failed";
          break;
        }
        const d = res.data as any;
        const notes = [...(d?.errors ?? []).map((e: string) => `Error: ${e}`), ...(d?.warnings ?? []).map((w: string) => `Note: ${w}`)].slice(0, 2);
        done.push(`${labelFor(`${kind.prefix}${key}`) ?? key}${notes.length ? ` (${notes.join(" ")})` : ""}`);
      }
      push(
        { role: "user", text: `/change ${text}`, intent: "revise", cards: mine, attached: attachedOf(named) },
        { role: "assistant", text: failed ?? `Changed ${done.join(" and ")} as a new proposal. Only ${done.length === 1 ? `this ${kind.item}` : `these ${kind.items}`} changed.` },
      );
      setThinking(false);
      router.refresh();
    });
  };

  const resend = (index: number, text: string) => {
    const history = turns.slice(0, index);
    const cards = turns[index]?.cards ?? [];
    truncateTurns(workspaceId, kind.scope, index);
    ask(text, { history, cards, attached: turns[index]?.attached ?? [] });
  };

  return (
    <div data-engineer-chat-host>
      <EngineerChat
        scope={kind.scope}
        turns={turns}
        pending=""
        thinking={thinking}
        emptyTitle={stepName === "org" ? "What would you like to check on the org web?" : stepName === "metrics" ? "What would you like to check on the metrics?" : stepName === "connect" ? "What would you like to know about this connection?" : "What would you like to check on the trial?"}
        intro={stepName === "trial" ? "Ask why a card was written, or press @ to attach one. Ask me to explain or simplify it." : stepName === "connect" ? "Ask what the connection can read: which views, fields and measures, how they link, and what is missing for sales, stock or purchasing." : `Ask about a ${kind.item}, or press @ to attach one. Ask me to explain or simplify, or start with /change to change it.`}
        placeholder={stepName === "org" ? "Ask about a role…" : stepName === "metrics" ? "Ask about a measure…" : stepName === "connect" ? "Ask about the connection…" : "Ask about a card…"}
        starters={starters}
        onAsk={(text) => ask(text)}
        onClear={clear}
        onResend={resend}
        onChange={stepName === "trial" || stepName === "connect" ? undefined : change}
        context={context}
        onDropContext={(id) => setDropped((d) => [...d, id])}
        mentionables={mentionables}
        mentions={mentions}
        onMentions={setMentioned}
      />
      <ChatJump count={mentions.length} />
    </div>
  );
}
