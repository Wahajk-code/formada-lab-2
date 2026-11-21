"use client";

import { Fragment, useEffect, useState } from "react";

/**
 * How the assistant's words are shown: a light version of what Claude or ChatGPT show.
 * - Formatting: paragraphs, bullet and numbered lists, short headings, **bold** and `code`.
 *   Everything is built as React nodes, never as raw HTML.
 * - Token by token: an answer that has just arrived is revealed a few words at a time with a soft
 *   caret. Older messages (loaded from the saved history) appear at once, and so does everything
 *   for people who prefer reduced motion.
 * The assistant's answer arrives whole, so this is how it is presented, not live streaming.
 */

const FRESH_MS = 6000; // an answer younger than this is revealed
const TICK_MS = 28;
const TARGET_TICKS = 110; // about three seconds for any length

function inline(text: string, key: string): React.ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) return <strong key={`${key}${i}`}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) return <code key={`${key}${i}`}>{part.slice(1, -1)}</code>;
    return <Fragment key={`${key}${i}`}>{part}</Fragment>;
  });
}

const LIST = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+/;
const HEADING = /^#{1,4}\s+(.*)$/;

/** Plain text with light structure, as React nodes. */
export function renderChat(text: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(<p key={`p${out.length}`}>{inline(para.join(" "), `p${out.length}`)}</p>);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    out.push(
      <Tag key={`l${out.length}`}>
        {list.items.map((item, i) => (
          <li key={i}>{inline(item, `l${out.length}-${i}`)}</li>
        ))}
      </Tag>,
    );
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const item = LIST.exec(line);
    const head = HEADING.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (item) {
      flushPara();
      const ordered = ORDERED.test(line);
      if (list && list.ordered !== ordered) flushList();
      list = list ?? { ordered, items: [] };
      list.items.push(item[1]);
    } else if (head) {
      flushPara();
      flushList();
      out.push(
        <p key={`h${out.length}`} className="chat-heading">
          <strong>{inline(head[1], `h${out.length}`)}</strong>
        </p>,
      );
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out;
}

function startingPoint(total: number, at?: number): number {
  if (!at || typeof window === "undefined") return total;
  if (Date.now() - at > FRESH_MS) return total;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return total;
  return 0;
}

export function ChatText({ text, at, onProgress }: { text: string; at?: number; onProgress?: () => void }) {
  const tokens = text.match(/\s+|\S+/g) ?? [];
  const [shown, setShown] = useState(() => startingPoint(tokens.length, at));
  const done = shown >= tokens.length;
  useEffect(() => {
    if (done) return;
    const step = Math.max(1, Math.ceil(tokens.length / TARGET_TICKS));
    const timer = window.setInterval(() => setShown((n) => Math.min(tokens.length, n + step)), TICK_MS);
    return () => window.clearInterval(timer);
  }, [done, tokens.length]);
  useEffect(() => {
    onProgress?.();
  }, [shown, onProgress]);
  const visible = done ? text : tokens.slice(0, shown).join("");
  return (
    <div className="chat-md" aria-live={done ? undefined : "off"}>
      {renderChat(visible)}
      {!done && <span className="stream-caret" aria-hidden="true" />}
    </div>
  );
}
