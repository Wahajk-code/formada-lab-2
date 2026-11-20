"use client";

import { useEffect, useRef, useState } from "react";

import { AnswerCheckLine } from "@/components/onboarding/answer-check";
import { Icon } from "@/components/ui/icon";
import type { AssistantTurn } from "@/lib/client-api";

export type RerunConfig = {
  disabled: boolean;
  locked: boolean;
  hint: string;
  label?: string;
};

type Props = {
  /** "Discovery / Data guide": shown under the title. */
  scope: string;
  turns: AssistantTurn[];
  /** The instruction being applied right now, shown as a pending exchange. */
  pending: string;
  /** True while an answer is being fetched (no instruction text to show). */
  thinking: boolean;
  emptyTitle: string;
  intro: string;
  placeholder: string;
  starters: string[];
  rerun?: RerunConfig | null;
  onAsk: (text: string) => void;
  onRerun?: (text: string) => void;
};

/** The engineering assistant (Formada.AI design, engineer-chat): ask about the section, or
 * rerun just that section with a correction. */
export function EngineerChat(props: Props) {
  const [expanded, setExpanded] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (expanded && !d.open) d.showModal();
    if (!expanded && d.open) d.close();
  }, [expanded]);
  // Keep the draft when the view changes between inline and full screen.
  const [draft, setDraft] = useState("");
  const shared = { ...props, draft, setDraft };
  return (
    <>
      <div data-engineer-chat hidden={expanded}>
        <Chat {...shared} expanded={false} onView={() => setExpanded(true)} />
      </div>
      <dialog
        ref={dialog}
        className="engineer-chat-dialog"
        aria-labelledby="engineer-chat-title"
        onClose={() => setExpanded(false)}
      >
        {expanded && <Chat {...shared} expanded onView={() => setExpanded(false)} />}
      </dialog>
    </>
  );
}

function Chat({
  scope,
  turns,
  pending,
  thinking,
  emptyTitle,
  intro,
  placeholder,
  starters,
  rerun,
  onAsk,
  onRerun,
  draft,
  setDraft,
  expanded,
  onView,
}: Props & { draft: string; setDraft: (v: string) => void; expanded: boolean; onView: () => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const busy = Boolean(pending) || thinking;
  const hasConversation = turns.length > 0 || busy;
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  const submit = (intent: "ask" | "rerun") => {
    const text = draft.trim();
    if (!text || busy) return;
    if (intent === "rerun" && (!rerun || rerun.disabled || !onRerun)) return;
    setDraft("");
    if (intent === "rerun") onRerun?.(text);
    else onAsk(text);
  };

  return (
    <section className={`engineer-chat${expanded ? " is-expanded" : ""}`} aria-label="Engineering assistant">
      <header className="engineer-chat-header">
        <span className="engineer-chat-mark" aria-hidden="true">
          <Icon name="sparkles" size={22} />
        </span>
        <div className="engineer-chat-heading">
          <h3 id={expanded ? "engineer-chat-title" : undefined}>Engineering assistant</h3>
          <span>{scope}</span>
        </div>
        <span className="engineer-chat-internal">Internal</span>
        <button
          className="icon-button engineer-chat-view"
          type="button"
          onClick={onView}
          aria-label={expanded ? "Close full-screen conversation" : "Open full-screen conversation"}
          title={expanded ? "Back to setup" : "Open full-screen conversation"}
        >
          <Icon name={expanded ? "x" : "expand"} size={19} />
        </button>
      </header>
      <div className="engineer-chat-scroll" tabIndex={0} aria-label="Conversation" ref={scroll}>
        {hasConversation ? (
          <ol className="engineer-chat-log" role="log" aria-label="Conversation history" aria-live="polite" aria-relevant="additions text">
            {turns.map((t, i) =>
              t.role === "user" ? (
                <li key={i} className="engineer-turn engineer-turn-user">
                  <article aria-label="Your message">{t.text}</article>
                </li>
              ) : (
                <li key={i} className="engineer-turn engineer-turn-assistant">
                  <span className="engineer-turn-mark" aria-hidden="true">
                    <Icon name="sparkles" size={18} />
                  </span>
                  <article>
                    <strong>Formada assistant</strong>
                    <p>{t.text}</p>
                    {t.check && <AnswerCheckLine check={t.check} audience="team" />}
                  </article>
                </li>
              ),
            )}
            {busy && (
              <>
                {pending && (
                  <li className="engineer-turn engineer-turn-user">
                    <article aria-label="Your message">{pending}</article>
                  </li>
                )}
                <li className="engineer-turn engineer-turn-assistant">
                  <span className="engineer-turn-mark" aria-hidden="true">
                    <Icon name="sparkles" size={18} />
                  </span>
                  <article>
                    <strong>Formada assistant</strong>
                    <p>{pending ? "Rerunning this section…" : "Thinking…"}</p>
                  </article>
                </li>
              </>
            )}
          </ol>
        ) : (
          <div className="engineer-chat-welcome">
            <div className="engineer-welcome-mark" aria-hidden="true">
              <Icon name="sparkles" size={24} />
            </div>
            <h4>{emptyTitle}</h4>
            <p>{intro}</p>
            <div className="engineer-chat-starters">
              {starters.map((s) => (
                <button key={s} type="button" onClick={() => setDraft(s)}>
                  {s}
                  <Icon name="arrow-up-right" size={15} />
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="engineer-chat-bottom">
        <form
          className="engineer-composer"
          onSubmit={(e) => {
            e.preventDefault();
            submit("ask");
          }}
        >
          <textarea
            aria-label="Message to the engineering assistant"
            name="message"
            rows={2}
            maxLength={1000}
            placeholder={placeholder}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              submit("ask");
            }}
          />
          <div className="engineer-composer-toolbar">
            {rerun && (
              <button
                className="engineer-rerun"
                type="button"
                disabled={rerun.disabled || busy || !draft.trim()}
                onClick={() => submit("rerun")}
              >
                <Icon name="refresh" size={17} />
                <span>{pending ? "Rerunning…" : (rerun.label ?? "Rerun section")}</span>
              </button>
            )}
            <button className="engineer-send" type="submit" aria-label="Send message" title="Send message" disabled={busy || !draft.trim()}>
              <Icon name="arrow-up" size={22} />
            </button>
          </div>
        </form>
        {rerun && (
          <p className="engineer-chat-note">
            <Icon name={rerun.locked ? "lock" : "info-circle"} size={15} />
            <span>{rerun.hint}</span>
          </p>
        )}
      </div>
    </section>
  );
}
