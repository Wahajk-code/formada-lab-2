"use client";

import { useRouter } from "next/navigation";
import { useLocale } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";

import type { Result } from "@/app/actions";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import type { Thread } from "@/lib/client-api";
import { cn } from "@/lib/utils";

export type QuestionLabels = {
  title: string;
  empty: string;
  emptyBody?: string;
  ask: string;
  askTitle: string;
  askBody: string;
  send: string;
  reply: string;
  resolve: string;
  resolved: string;
  open?: string;
  waitingOnYou: string;
  waitingOnThem: string;
  you: string;
  cancel: string;
  showResolved: (n: number) => string;
  openCount?: (n: number) => string;
  noOpen?: string;
  allThreads?: string;
  subject?: string;
  message?: string;
  resolvedNote?: string;
  viaEmail?: string;
};

export const TEAM_LABELS: QuestionLabels = {
  title: "Questions",
  empty: "No conversations yet",
  emptyBody: "Ask the signup contact for details about this step.",
  ask: "Ask customer",
  askTitle: "What would you like to ask?",
  askBody: "What should the customer know? They see it here and by email.",
  send: "Send question",
  reply: "Send reply",
  resolve: "Resolve thread",
  resolved: "Resolved",
  open: "Open",
  waitingOnYou: "Needs our answer",
  waitingOnThem: "Waiting on customer",
  you: "Formada",
  cancel: "Cancel",
  showResolved: (n) => `${n} resolved`,
  openCount: (n) => `${n} open ${n === 1 ? "thread" : "threads"}`,
  noOpen: "No open threads",
  allThreads: "All threads",
  subject: "Subject",
  message: "Message",
  resolvedNote: "This conversation is resolved.",
  viaEmail: "App + email",
};

const COMPOSER =
  "grid min-w-0 gap-1 rounded-[15px] border border-border bg-card p-2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-iris";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Questions on one step, from the viewer's side (the design's Questions card). Both sides see
 * the same threads; team questions also reach the client by email. */
export function Questions({
  threads,
  side,
  labels,
  onAsk,
  onReply,
  onResolve,
  can,
  defaultTitle = "",
  initialThread = null,
}: {
  threads: Thread[];
  side: "team" | "client";
  labels: QuestionLabels;
  onAsk: (title: string, body: string) => Promise<Result<unknown>>;
  onReply: (id: string, body: string) => Promise<Result<unknown>>;
  onResolve: (id: string) => Promise<Result<unknown>>;
  can: boolean;
  defaultTitle?: string;
  initialThread?: string | null;
}) {
  const router = useRouter();
  const locale = useLocale();
  const [view, setView] = useState<{ kind: "list" } | { kind: "new" } | { kind: "thread"; id: string }>(
    initialThread && threads.some((t) => t.id === initialThread) ? { kind: "thread", id: initialThread } : { kind: "list" },
  );
  const [title, setTitle] = useState(defaultTitle);
  const [body, setBody] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const timeline = useRef<HTMLOListElement>(null);
  const open = threads.filter((t) => t.status === "open");
  const selected = view.kind === "thread" ? threads.find((t) => t.id === view.id) : undefined;
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { month: "short", day: "numeric", timeZone: "UTC" });

  useEffect(() => {
    if (timeline.current) timeline.current.scrollTop = timeline.current.scrollHeight;
  }, [selected?.messages.length]);

  const run = (fn: () => Promise<Result<unknown>>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      setError(res.ok ? null : res.error);
      if (res.ok) after?.();
      router.refresh();
    });

  const composer = (mode: "new" | "reply") => (
    <div className="grid gap-[7px]">
      {mode === "new" && (
        <label className="grid gap-1.5 text-[13px] font-extrabold">
          {labels.subject ?? labels.askTitle}
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={85}
            placeholder={labels.askTitle}
            className="min-h-11 w-full rounded-[10px] border border-border bg-surface-strong px-[11px] text-sm font-medium outline-none focus:outline-2 focus:outline-offset-2 focus:outline-iris"
          />
        </label>
      )}
      <div className={COMPOSER}>
        {mode === "new" && <span className="px-[3px] text-[13px] font-extrabold">{labels.message ?? labels.send}</span>}
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={mode === "new" ? 3 : 2}
          maxLength={1200}
          placeholder={mode === "new" ? labels.askBody : labels.reply}
          aria-label={mode === "new" ? labels.message ?? labels.send : labels.reply}
          className="min-h-[55px] w-full resize-y border-0 bg-transparent px-[3px] py-[5px] text-[13px] leading-normal outline-none"
        />
        <div className="flex flex-wrap items-center justify-end gap-2">
          {side === "team" && labels.viaEmail && (
            <span className="mr-auto flex items-center gap-1 text-[11px] font-bold text-muted-foreground">
              <Icon name="mail" size={15} /> {labels.viaEmail}
            </span>
          )}
          <Button
            size="sm"
            disabled={pending || !body.trim() || (mode === "new" && !title.trim() && !defaultTitle)}
            onClick={() =>
              run(
                () => (mode === "new" ? onAsk(title, body) : onReply(selected!.id, body)),
                () => {
                  setBody("");
                  if (mode === "new") {
                    setTitle(defaultTitle);
                    setView({ kind: "list" });
                  }
                },
              )
            }
          >
            <Icon name="send" size={15} /> {mode === "new" ? labels.send : labels.reply}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <section className="overflow-hidden rounded-3xl border border-border bg-card">
      <header className="flex items-center gap-2.5 border-b border-border bg-surface p-3.5">
        <span className="grid size-[35px] shrink-0 place-items-center rounded-[11px] bg-soft-violet text-iris">
          <Icon name="messages" size={20} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-lg font-bold">{labels.title}</h2>
          <small className="text-xs text-muted-foreground">
            {open.length ? (labels.openCount?.(open.length) ?? `${open.length}`) : (labels.noOpen ?? "")}
          </small>
        </div>
        {can && view.kind === "list" && threads.length > 0 && (
          <button
            type="button"
            onClick={() => setView({ kind: "new" })}
            aria-label={labels.ask}
            title={labels.ask}
            className="grid size-11 place-items-center rounded-[10px] border border-border bg-card text-iris hover:bg-soft-violet"
          >
            <Icon name="plus" size={19} />
          </button>
        )}
      </header>

      {view.kind === "new" ? (
        <div className="px-3.5 pt-0.5 pb-3">
          <button type="button" onClick={() => setView({ kind: "list" })} className="inline-flex min-h-11 items-center gap-2 text-xs font-bold text-iris hover:text-iris-ink">
            <Icon name="arrow-left" size={16} /> {labels.allThreads ?? labels.cancel}
          </button>
          {composer("new")}
        </div>
      ) : selected ? (
        <div className="px-3.5 pt-0.5 pb-3">
          <div className="flex items-center justify-between gap-2">
            <button type="button" onClick={() => setView({ kind: "list" })} className="inline-flex min-h-11 items-center gap-2 text-xs font-bold text-iris hover:text-iris-ink">
              <Icon name="arrow-left" size={16} /> {labels.allThreads ?? labels.cancel}
            </button>
            {can && side === "team" && selected.status === "open" && (
              <button type="button" disabled={pending} onClick={() => run(() => onResolve(selected.id))} className="inline-flex min-h-11 items-center gap-1.5 text-xs font-bold text-muted-foreground hover:text-foreground">
                <Icon name="check" size={16} /> {labels.resolve}
              </button>
            )}
          </div>
          <div className="mb-2 flex items-start justify-between gap-1.5">
            <h3 className="text-[17px] leading-tight font-bold break-words">{selected.title}</h3>
            <span className={cn("tag shrink-0", selected.status === "resolved" ? "tag-positive" : "tag-iris")}>
              {selected.status === "resolved" ? labels.resolved : (labels.open ?? "Open")}
            </span>
          </div>
          <ol ref={timeline} className="mb-2 grid max-h-[330px] gap-[9px] overflow-y-auto overscroll-contain p-0.5" tabIndex={0}>
            {selected.messages.map((m) => {
              const own = m.side === side;
              const who = m.side === "team" ? "formada" : "customer";
              return (
                <li key={m.id} className="flex items-start gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      "mt-[3px] grid size-[26px] shrink-0 place-items-center rounded-full text-[10px] font-extrabold",
                      who === "formada" ? "bg-ice-blue text-[#354866]" : "bg-soft-violet text-[#5938a6]",
                    )}
                  >
                    {initials(m.author || (own ? labels.you : ""))}
                  </span>
                  <div className={cn("min-w-0 flex-1 rounded-[4px_12px_12px_12px] px-[9px] py-2", own ? "bg-soft-violet" : "bg-surface-strong")}>
                    <div className="flex flex-wrap items-baseline gap-x-1.5 text-xs">
                      <strong className="break-words">{m.author || labels.you}</strong>
                      <time dateTime={m.at} className="text-[11px] text-muted-foreground">
                        {day(m.at)}
                      </time>
                    </div>
                    <p className="mt-1 mb-1 text-[13px] leading-snug break-words whitespace-pre-wrap">{m.body}</p>
                    <span className="inline-flex items-center gap-[3px] text-[11px] font-semibold text-muted-foreground">
                      <Icon name={m.side === "team" ? "mail" : "message-circle"} size={13} />
                      {m.side === "team" && labels.viaEmail ? labels.viaEmail : "In app"}
                    </span>
                  </div>
                </li>
              );
            })}
          </ol>
          {selected.status === "resolved" && (
            <p className="mb-2 flex items-center gap-1.5 rounded-[10px] bg-positive px-2.5 py-2 text-sm font-bold text-positive-ink">
              <Icon name="check-circle" size={16} /> {labels.resolvedNote ?? labels.resolved}
            </p>
          )}
          {can && composer("reply")}
        </div>
      ) : threads.length ? (
        <div className="grid max-h-[300px] gap-[3px] overflow-y-auto p-1.5">
          {threads.map((t) => {
            const last = t.messages.at(-1);
            const resolved = t.status === "resolved";
            const mine = t.waiting_on === side && !resolved;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setView({ kind: "thread", id: t.id })}
                className="grid min-h-16 w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-[13px] bg-card px-2 py-[9px] text-left text-muted-foreground hover:bg-surface"
              >
                <span className={cn("grid size-[34px] place-items-center rounded-[11px]", resolved ? "bg-positive text-positive-ink" : "bg-soft-violet text-iris")}>
                  <Icon name={resolved ? "check-circle" : "message-circle"} size={17} />
                </span>
                <span className="grid min-w-0 gap-1">
                  <strong className="text-[13px] leading-tight font-extrabold break-words text-foreground">{t.title}</strong>
                  <small className="truncate text-xs">{last?.body}</small>
                </span>
                <span className="grid justify-items-end gap-1 text-[11px] whitespace-nowrap">
                  <span className={cn("font-bold", resolved ? "text-positive-ink" : mine ? "text-iris" : "")}>
                    {resolved ? labels.resolved : mine ? labels.waitingOnYou : (labels.open ?? labels.waitingOnThem)}
                  </span>
                  <time dateTime={t.updated_at}>{day(t.updated_at)}</time>
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="p-4">
          <strong className="text-sm">{labels.empty}</strong>
          {labels.emptyBody && <p className="mt-1 text-[13px] text-muted-foreground">{labels.emptyBody}</p>}
          {can && (
            <button type="button" onClick={() => setView({ kind: "new" })} className="mt-1 inline-flex min-h-11 items-center gap-1.5 text-sm font-bold text-iris hover:text-iris-ink">
              <Icon name="plus" size={17} /> {labels.ask}
            </button>
          )}
        </div>
      )}
      {error && <p className="px-4 pb-3 text-xs text-destructive">{error}</p>}
    </section>
  );
}
