"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ChatTurn } from "@/components/console/onboarding/chat-turn";
import { ThinkingMark } from "@/components/console/onboarding/thinking-mark";
import { Icon } from "@/components/ui/icon";
import type { AssistantTurn } from "@/lib/client-api";
import { CHANGE_WORD, isChange, withoutChangeWord } from "@/lib/mentions";

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
  /** Cards the user can name with @ (IDE-style). Optional: other steps do not use it. */
  mentionables?: Mentionable[];
  mentions?: string[];
  onMentions?: (ids: string[]) => void;
  /** Rendered after the last message: the review of changes the assistant suggests. */
  extra?: React.ReactNode;
  /** Forget the saved conversation (it is kept until onboarding is done). */
  onClear?: () => void;
  /** Ask again with an edited message, from that message on (the messages below are cleared). */
  onResend?: (index: number, text: string) => void;
  /** What was attached earlier and still counts as context (not in the input any more). */
  context?: { id: string; label: string }[];
  onDropContext?: (id: string) => void;
  /** The message started with /change: the AI is authorised to propose the change. */
  onChange?: (text: string) => void;
};

/** `note` replaces the chip's hover text (for example "Measured: read-only"). */
export type Mentionable = { id: string; label: string; kind: string; locked: boolean; note?: string };

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
      <div id="engineer-chat" data-engineer-chat hidden={expanded}>
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
  mentionables = [],
  mentions = [],
  onMentions,
  extra,
  onClear,
  onResend,
  context = [],
  onDropContext,
  onChange,
  draft,
  setDraft,
  expanded,
  onView,
}: Props & { draft: string; setDraft: (v: string) => void; expanded: boolean; onView: () => void }) {
  const scroll = useRef<HTMLDivElement>(null);
  const busy = Boolean(pending) || thinking;
  const hasConversation = turns.length > 0 || busy || Boolean(extra);
  const follow = useCallback(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);
  const [picker, setPicker] = useState<{ query: string; start: number; end: number; index: number } | null>(null);
  const byId = new Map(mentionables.map((m) => [m.id, m]));
  const options = picker
    ? mentionables
        .filter((m) => !mentions.includes(m.id) && `${m.kind} ${m.label}`.toLowerCase().includes(picker.query.toLowerCase()))
        .slice(0, 8)
    : [];
  const choose = (m: Mentionable) => {
    if (!picker || !onMentions) return;
    setDraft(`${draft.slice(0, picker.start)}${draft.slice(picker.end)}`.replace(/ {2,}/g, " "));
    if (mentions.length < 8) onMentions([...mentions, m.id]);
    setPicker(null);
  };
  const watch = (value: string, caret: number) => {
    if (!onMentions || !mentionables.length) return;
    const found = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    setPicker(found ? { query: found[2], start: caret - found[2].length - 1, end: caret, index: 0 } : null);
  };
  useEffect(() => {
    const el = scroll.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length, busy]);

  const submit = (intent: "ask" | "rerun") => {
    const text = draft.trim();
    if (!text || busy) return;
    if (intent === "rerun" && (!rerun || rerun.disabled || !onRerun)) return;
    setDraft("");
    // What was attached moves onto the message that is sent, so the input starts clean. It stays in
    // the conversation's context (see `context`).
    if (intent === "ask" && onChange && isChange(text)) onChange(withoutChangeWord(text));
    else if (intent === "rerun") onRerun?.(text);
    else onAsk(text);
    onMentions?.([]);
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
            {turns.map((t, i) => (
              <ChatTurn key={`${i}:${t.at ?? 0}`} turn={t} canEdit={Boolean(onResend) && !busy && (!t.scope || t.scope === scope)} elsewhere={t.scope && t.scope !== scope ? t.scope : null} onResend={(text) => onResend?.(i, text)} onProgress={follow} />
            ))}
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
                  <article className="engineer-thinking">
                    <strong>Formada assistant</strong>
                    <ThinkingMark label={pending ? "Rerunning this section" : "The assistant is thinking"} />
                  </article>
                </li>
              </>
            )}
            {extra && <li className="engineer-turn engineer-turn-assistant engineer-turn-extra">{extra}</li>}
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
          {context.length > 0 && (
            <div className="mention-chips mention-context" aria-label="Still in the conversation's context">
              <small>In context</small>
              {context.map((c) => (
                <span key={c.id} className="mention-chip is-context" title="Attached earlier. It stays in the conversation until you remove it.">
                  <span aria-hidden="true">@</span>
                  {c.label}
                  {onDropContext && (
                    <button type="button" aria-label={`Remove ${c.label} from the context`} onClick={() => onDropContext(c.id)}>
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {mentions.length > 0 && (
            <div className="mention-chips" aria-label="Cards in this message">
              {mentions.map((id) => {
                const m = byId.get(id);
                return (
                  <span key={id} className={`mention-chip${m?.locked ? " is-locked" : ""}`} title={m?.note ?? (m?.locked ? "Locked: it will not be changed" : "Can be changed")}>
                    <span aria-hidden="true">@</span>
                    {m?.label ?? id}
                    {m?.locked && <Icon name="lock" size={12} />}
                    <button type="button" aria-label={`Remove ${m?.label ?? id}`} onClick={() => onMentions?.(mentions.filter((x) => x !== id))}>
                      <Icon name="x" size={12} />
                    </button>
                  </span>
                );
              })}
            </div>
          )}
          <div className="mention-wrap">
            <textarea
              aria-label="Message to the engineering assistant"
              name="message"
              rows={2}
              maxLength={1000}
              placeholder={placeholder}
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                watch(e.target.value, e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyDown={(e) => {
                if (picker && options.length) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    const n = options.length;
                    setPicker({ ...picker, index: (picker.index + (e.key === "ArrowDown" ? 1 : n - 1)) % n });
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    choose(options[Math.min(picker.index, options.length - 1)]);
                    return;
                  }
                }
                if (picker && e.key === "Escape") {
                  setPicker(null);
                  return;
                }
                if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
                e.preventDefault();
                submit("ask");
              }}
            />
            {picker && (
              <ul className="mention-picker" role="listbox" aria-label="Cards you can mention">
                {options.length ? (
                  options.map((m, i) => (
                    <li key={m.id} role="option" aria-selected={i === picker.index}>
                      <button type="button" className={i === picker.index ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); choose(m); }}>
                        <span className="mention-kind">{m.kind}</span>
                        <span className="mention-name">{m.label}</span>
                        {m.locked && <Icon name="lock" size={12} />}
                      </button>
                    </li>
                  ))
                ) : (
                  <li className="mention-empty">No card matches</li>
                )}
              </ul>
            )}
          </div>
          <div className="engineer-composer-toolbar">
            {onMentions && mentionables.length > 0 && (
              <button className="engineer-rerun" type="button" title="Mention a card" onClick={() => { setDraft(`${draft}${draft && !draft.endsWith(" ") ? " " : ""}@`); setPicker({ query: "", start: draft.length + (draft && !draft.endsWith(" ") ? 1 : 0), end: draft.length + (draft && !draft.endsWith(" ") ? 2 : 1), index: 0 }); }}>
                <span aria-hidden="true">@</span>
                <span>Mention</span>
              </button>
            )}
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
        {onChange && (
          <p className="engineer-chat-note">
            <Icon name="pen" size={15} />
            <span>
              Start a message with <b>{CHANGE_WORD}</b> to have the AI change what you attached, whatever it thinks of the change. You see every change before it is applied.
            </span>
          </p>
        )}
        {onClear && turns.length > 0 && !busy && (
          <p className="engineer-chat-note">
            <Icon name="clock" size={15} />
            <span>This conversation is saved until onboarding is done.</span>
            <button type="button" className="engineer-clear" onClick={onClear}>
              Clear it
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
