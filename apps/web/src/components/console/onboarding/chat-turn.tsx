"use client";

import { useRef, useState } from "react";

import { ChatText } from "@/components/console/onboarding/chat-text";
import { AnswerCheckLine } from "@/components/onboarding/answer-check";
import { Icon } from "@/components/ui/icon";
import type { AssistantTurn } from "@/lib/client-api";

/** One message of the conversation. Copy is on every message. Edit is on your own questions and
 * works the way it does in ChatGPT and Claude: the message turns into a box right where it is,
 * with Cancel and Send. Nothing changes until you send; sending asks again from that point and
 * clears everything below it. The tools fade in when the message is hovered or focused. */
export function ChatTurn({
  turn,
  canEdit,
  elsewhere,
  onResend,
  onProgress,
}: {
  turn: AssistantTurn;
  canEdit: boolean;
  /** The page this message was written on, when it is not the one being shown. */
  elsewhere?: string | null;
  /** Ask again with this text, from this message on. */
  onResend: (text: string) => void;
  onProgress: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(turn.text);
  const box = useRef<HTMLTextAreaElement>(null);
  const copy = () => {
    navigator.clipboard
      .writeText(turn.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined); // some app views refuse clipboard writes
  };
  const open = () => {
    setDraft(turn.text);
    setEditing(true);
    window.setTimeout(() => {
      const el = box.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    }, 0);
  };
  const send = () => {
    const text = draft.trim();
    if (!text) return;
    setEditing(false);
    onResend(text);
  };
  const canResend = canEdit && (turn.intent === "ask" || turn.intent === "suggest");
  const tools = (
    <div className="turn-actions" role="toolbar" aria-label="Message tools">
      <button type="button" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}
      </button>
      {turn.role === "user" && canResend && (
        <button type="button" onClick={open}>
          <Icon name="edit" size={14} /> Edit
        </button>
      )}
    </div>
  );

  if (turn.role === "user" && editing)
    return (
      <li className="engineer-turn engineer-turn-user is-editing">
        <div className="turn-col turn-edit">
          <textarea
            ref={box}
            aria-label="Edit your message"
            value={draft}
            maxLength={1000}
            rows={Math.min(8, Math.max(2, draft.split("\n").length + Math.floor(draft.length / 70)))}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setEditing(false);
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="turn-edit-actions">
            <small>Sending asks again from here and clears the messages below.</small>
            <button type="button" className="btn btn-secondary" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!draft.trim()} onClick={send}>
              Send
            </button>
          </div>
        </div>
      </li>
    );

  if (turn.role === "user")
    return (
      <li className="engineer-turn engineer-turn-user turn-hover">
        <div className="turn-col">
          {(turn.attached ?? []).length > 0 && (
            <div className="turn-attached" aria-label="Attached to this message">
              {(turn.attached ?? []).map((a) => (
                <span key={a.id} className="mention-chip is-sent">
                  <span aria-hidden="true">@</span>
                  {a.label}
                </span>
              ))}
            </div>
          )}
          <article aria-label="Your message">{turn.text}</article>
          {elsewhere && <small className="turn-scope">Asked in {elsewhere}</small>}
          {tools}
        </div>
      </li>
    );
  return (
    <li className="engineer-turn engineer-turn-assistant turn-hover">
      <span className="engineer-turn-mark" aria-hidden="true">
        <Icon name="sparkles" size={18} />
      </span>
      <div className="turn-col">
        <article>
          <strong>Formada assistant</strong>
          <ChatText text={turn.text} at={turn.at} onProgress={onProgress} />
          {turn.check && <AnswerCheckLine check={turn.check} audience="team" />}
        </article>
        {tools}
      </div>
    </li>
  );
}
