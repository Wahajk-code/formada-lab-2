"use client";

import { useTranslations } from "next-intl";

import {
  askTeam,
  replyToTeam,
  resolveClientThread,
} from "@/app/onboarding-actions";
import {
  type QuestionLabels,
  Questions,
} from "@/components/onboarding/questions";
import type { Thread, ThreadStep } from "@/lib/client-api";

/** The client's questions on one onboarding step. */
export function ClientQuestions({
  step,
  threads,
  can,
  initialThread = null,
}: {
  step: ThreadStep;
  threads: Thread[];
  can: boolean;
  initialThread?: string | null;
}) {
  const t = useTranslations("questions");
  const labels: QuestionLabels = {
    title: t("title"),
    empty: t("empty"),
    ask: t("ask"),
    askTitle: t("askTitle"),
    askBody: t("askBody"),
    send: t("send"),
    reply: t("reply"),
    resolve: t("resolve"),
    resolved: t("resolved"),
    waitingOnYou: t("waitingOnYou"),
    waitingOnThem: t("waitingOnThem"),
    you: t("you"),
    cancel: t("cancel"),
    showResolved: (n) => t("showResolved", { n }),
    emptyBody: t("emptyBody"),
    open: t("open"),
    openCount: (n) => t("openCount", { n }),
    noOpen: t("noOpen"),
    allThreads: t("allThreads"),
    subject: t("subject"),
    message: t("message"),
    resolvedNote: t("resolvedNote"),
  };
  return (
    <Questions
      threads={threads}
      side="client"
      labels={labels}
      can={can}
      onAsk={(title, body) => askTeam(step, title, body)}
      onReply={replyToTeam}
      onResolve={resolveClientThread}
      initialThread={initialThread}
    />
  );
}
