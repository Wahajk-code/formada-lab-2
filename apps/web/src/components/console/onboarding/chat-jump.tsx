"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/icon";

/** A floating button that appears while the chat at the bottom of the page is out of view, and
 * snaps you to it (with the message box ready). It shows how many cards are waiting in the chat. */
export function ChatJump({ targetId = "engineer-chat", count = 0 }: { targetId?: string; count?: number }) {
  const [away, setAway] = useState(false);
  useEffect(() => {
    const el = document.getElementById(targetId);
    if (!el || typeof IntersectionObserver === "undefined") return;
    const watch = new IntersectionObserver(([entry]) => setAway(!entry.isIntersecting), { threshold: 0.1 });
    watch.observe(el);
    return () => watch.disconnect();
  }, [targetId]);
  if (!away) return null;

  const go = () => {
    const el = document.getElementById(targetId);
    if (!el) return;
    const calm = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: calm ? "auto" : "smooth", block: "end" });
    window.setTimeout(() => el.querySelector<HTMLTextAreaElement>("textarea")?.focus({ preventScroll: true }), calm ? 0 : 500);
  };
  return (
    <button type="button" className="chat-jump" onClick={go} aria-label={count ? `Go to the chat. ${count} in the message` : "Go to the chat"}>
      <Icon name="sparkles" size={18} />
      <span>Chat</span>
      {count > 0 && <b className="chat-jump-count">{count}</b>}
    </button>
  );
}
