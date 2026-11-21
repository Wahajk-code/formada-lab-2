import { useCallback, useSyncExternalStore } from "react";

import type { AssistantTurn } from "@/lib/client-api";

/**
 * The engineering assistant's conversation, kept in this browser per workspace and step, so it
 * survives a refresh, leaving the step and coming back. It is cleared when the workspace goes
 * live (onboarding is done) or when the person clears it.
 *
 * Browser storage can be missing or blocked, so every read and write is guarded and an in-memory
 * copy keeps the chat working for the current visit.
 */

const PREFIX = "formada.chat.v1";
const MAX_TURNS = 80;
const EMPTY: AssistantTurn[] = [];
const listeners = new Set<() => void>();
const memory = new Map<string, AssistantTurn[]>();
const cache = new Map<string, { raw: string | null; turns: AssistantTurn[] }>();

const keyOf = (workspaceId: string, scope: string) => `${PREFIX}.${workspaceId}.${scope}`;
const notify = () => listeners.forEach((l) => l());
const valid = (t: unknown): t is AssistantTurn =>
  Boolean(t) && typeof t === "object" && ((t as AssistantTurn).role === "user" || (t as AssistantTurn).role === "assistant") && typeof (t as AssistantTurn).text === "string";

function read(key: string): AssistantTurn[] {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(key);
  } catch {
    return memory.get(key) ?? EMPTY; // storage blocked: this visit only
  }
  const hit = cache.get(key);
  if (hit && hit.raw === raw) return hit.turns;
  let turns = EMPTY;
  if (raw) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) turns = parsed.filter(valid).slice(-MAX_TURNS);
    } catch {
      turns = EMPTY;
    }
  }
  cache.set(key, { raw, turns });
  return turns;
}

function write(key: string, turns: AssistantTurn[]) {
  const kept = turns.slice(-MAX_TURNS);
  memory.set(key, kept);
  try {
    if (kept.length) window.localStorage.setItem(key, JSON.stringify(kept));
    else window.localStorage.removeItem(key);
  } catch {
    /* storage full or blocked: the in-memory copy still works */
  }
  notify();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener); // another tab changed it
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** Add turns to a conversation (safe to call after the page has moved on). */
export function appendTurns(workspaceId: string, scope: string, ...more: AssistantTurn[]) {
  const key = keyOf(workspaceId, scope);
  const at = Date.now(); // lets a just-arrived answer be revealed word by word
  write(key, [...read(key), ...more.map((t) => ({ at, ...t }))]);
}

/** Drop a message and everything after it (the person is editing it). */
export function truncateTurns(workspaceId: string, scope: string, from: number) {
  const key = keyOf(workspaceId, scope);
  write(key, read(key).slice(0, Math.max(0, from)));
}

/** Forget every conversation of a workspace (onboarding is finished). */
export function clearWorkspaceChats(workspaceId: string) {
  const start = `${PREFIX}.${workspaceId}.`;
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith(start)) window.localStorage.removeItem(k);
  } catch {
    /* storage blocked */
  }
  for (const k of [...memory.keys()]) if (k.startsWith(start)) memory.delete(k);
  notify();
}

/** The saved conversation of one step (and tab). Empty on the server, so the page renders the same
 * on both sides, then fills in. */
export function useChatTurns(workspaceId: string, scope: string) {
  const key = keyOf(workspaceId, scope);
  const turns = useSyncExternalStore(
    subscribe,
    () => read(key),
    () => EMPTY,
  );
  const clear = useCallback(() => write(key, []), [key]);
  return { turns, clear };
}
