"use client";

import { useState } from "react";

import { ChatText } from "@/components/console/onboarding/chat-text";
import { AnswerCheckLine } from "@/components/onboarding/answer-check";
import { Icon } from "@/components/ui/icon";
import type { AssistantTurn } from "@/lib/client-api";

/** One message of the conversation. Copy is on every message; Edit is on your own: it puts the
 * text back in the message box and drops that message and everything after it, so you can
 * rephrase and send again. The tools fade in when the message is hovered or focused. */
export function ChatTurn({
  turn,
  canEdit,
  onEdit,
  onProgress,
}: {
  turn: AssistantTurn;
  canEdit: boolean;
  onEdit: () => void;
  onProgress: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      .writeText(turn.text)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => undefined); // some app views refuse clipboard writes
  };
  const tools = (
    <div className="turn-actions" role="toolbar" aria-label="Message tools">
      <button type="button" onClick={copy}>
        <Icon name={copied ? "check" : "copy"} size={14} /> {copied ? "Copied" : "Copy"}
      </button>
      {turn.role === "user" && canEdit && (
        <button type="button" onClick={onEdit}>
          <Icon name="edit" size={14} /> Edit
        </button>
      )}
    </div>
  );

  if (turn.role === "user")
    return (
      <li className="engineer-turn engineer-turn-user turn-hover">
        <div className="turn-col">
          <article aria-label="Your message">{turn.text}</article>
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
