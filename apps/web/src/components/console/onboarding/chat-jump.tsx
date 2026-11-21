"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { Icon } from "@/components/ui/icon";

/** A floating button that appears while the chat at the bottom of the page is out of view, and
 * snaps you to it (with the message box ready). It shows how many cards are waiting in the chat.
 *
 * It is drawn straight into the page body, so no animated or scrolling parent can hold it back,
 * and it watches scrolling in any container, not only the window. */
export function ChatJump({ targetId = "engineer-chat", count = 0 }: { targetId?: string; count?: number }) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      const el = document.getElementById(targetId);
      if (!el) return setAway(false);
      const r = el.getBoundingClientRect();
      const inView = r.top < window.innerHeight - 96 && r.bottom > 96; // a clear part of it is showing
      setAway(!inView);
    };
    const queue = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    queue();
    window.addEventListener("resize", queue);
    document.addEventListener("scroll", queue, true); // capture: scrolling inside any container
    const timer = window.setInterval(queue, 1500); // layout can change without a scroll
    return () => {
      window.removeEventListener("resize", queue);
      document.removeEventListener("scroll", queue, true);
      window.clearInterval(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [targetId]);
  if (!away || typeof document === "undefined") return null;

  const go = () => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "end" });
    window.setTimeout(() => el.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }), calm ? 0 : 500);
  };
  return createPortal(
    <button type="button" className="chat-jump" onClick={go} aria-label={count ? `Go to the chat. ${count} in the message` : "Go to the chat"}>
      <Icon name="sparkles" size={18} />
      <span>Chat</span>
      {count > 0 && <b className="chat-jump-count">{count}</b>}
    </button>,
    document.body,
  );
}
