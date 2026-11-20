"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { type ActionDefaults, api, ApiError, SESSION_COOKIE, type Translation } from "@/lib/client-api";
import { LOCALE_COOKIE, type Locale, locales } from "@/i18n/request";

const COOKIE = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };

export async function signIn(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  const { token } = await api.devLogin(email);
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...COOKIE, maxAge: 12 * 60 * 60 });
  if (!store.get(LOCALE_COOKIE)) {
    const me = await api.me(token);
    store.set(LOCALE_COOKIE, me.locale, { ...COOKIE, httpOnly: false, maxAge: 31536000 });
  }
  redirect("/dashboard");
}

export async function signOut() {
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}

export async function setLocale(locale: Locale) {
  if (!locales.includes(locale)) return;
  (await cookies()).set(LOCALE_COOKIE, locale, { ...COOKIE, httpOnly: false, maxAge: 31536000 });
}

export type Result<T = undefined> = { ok: true; data?: T } | { ok: false; error: string };

async function attempt<T>(fn: () => Promise<T>, paths: string[]): Promise<Result<T>> {
  try {
    const data = await fn();
    for (const p of paths) revalidatePath(p);
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    throw e;
  }
}

const CARD_PATHS = ["/cards", "/dashboard", "/ledger", "/history", "/org"];

export async function getActionDefaults(cardId: string): Promise<Result<ActionDefaults>> {
  return attempt(() => api.actionDefaults(cardId), []);
}

export async function actionCard(cardId: string, body: Record<string, unknown>): Promise<Result> {
  return attempt(async () => void (await api.actionCard(cardId, body)), CARD_PATHS);
}

export async function giveFeedback(
  cardId: string,
  type: "not_relevant" | "impossible",
  reason: string,
): Promise<Result> {
  return attempt(async () => void (await api.feedback(cardId, type, reason.trim() || null)), CARD_PATHS);
}

export async function getCard(id: string): Promise<Result<import("@/lib/client-api").Card>> {
  return attempt(() => api.card(id), []);
}

export async function decideInitiative(initiativeId: string, choice: "keep" | "stop"): Promise<Result> {
  return attempt(async () => void (await api.decide(initiativeId, choice)), ["/ledger"]);
}

export async function reviewRule(
  ruleId: string,
  action: "accept" | "reject" | "retire",
  text?: string,
): Promise<Result> {
  return attempt(async () => void (await api.reviewRule(ruleId, action, text)), ["/settings"]);
}

export async function runNow(): Promise<Result> {
  return attempt(async () => void (await api.runNow()), ["/settings", "/dashboard"]);
}

const PEOPLE = ["/settings"];

export async function invitePerson(body: Record<string, unknown>): Promise<Result<{ link?: string }>> {
  return attempt(async () => (await api.invite(body)) as { link?: string }, PEOPLE);
}

export async function resendInvite(id: string): Promise<Result<{ link?: string }>> {
  return attempt(async () => (await api.resendInvite(id)) as { link?: string }, PEOPLE);
}

export async function revokeInvite(id: string): Promise<Result> {
  return attempt(async () => void (await api.revokeInvite(id)), PEOPLE);
}

export async function setPersonRole(id: string, appRole: string): Promise<Result> {
  return attempt(async () => void (await api.setPersonRole(id, appRole)), PEOPLE);
}

export async function setPersonAssignments(
  id: string,
  assignments: { role_node_id: string; permission: string }[],
): Promise<Result> {
  return attempt(async () => void (await api.setAssignments(id, assignments)), [...PEOPLE, "/org", "/cards"]);
}

export async function removePerson(id: string): Promise<Result> {
  return attempt(async () => void (await api.removePerson(id)), PEOPLE);
}

export async function updateWorkspace(body: Record<string, unknown>): Promise<Result> {
  return attempt(async () => void (await api.updateWorkspace(body)), PEOPLE);
}

export async function translateCard(cardId: string, language: string): Promise<Result<Translation>> {
  return attempt(() => api.translate(cardId, language), []);
}

export async function acceptInvite(token: string, formData: FormData) {
  const password = String(formData.get("password") ?? "");
  if (password !== String(formData.get("confirm") ?? "")) redirect(`/invite/${token}?error=mismatch`);
  let session: string;
  try {
    ({ token: session } = await api.acceptInvite(token, String(formData.get("name") ?? ""), password));
  } catch (e) {
    if (e instanceof ApiError) redirect(`/invite/${token}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  await startSession(session);
  redirect("/dashboard");
}

async function startSession(token: string) {
  const store = await cookies();
  store.set(SESSION_COOKIE, token, { ...COOKIE, maxAge: 12 * 60 * 60 });
  if (!store.get(LOCALE_COOKIE)) {
    const me = await api.me(token);
    store.set(LOCALE_COOKIE, me.locale, { ...COOKIE, httpOnly: false, maxAge: 31536000 });
  }
}

/** In-app sign-in (ADR 0023). Errors are generic on purpose: no hint whether the email exists. */
export async function signInWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  let token: string;
  try {
    ({ token } = await api.login(email, String(formData.get("password") ?? "")));
  } catch (e) {
    if (e instanceof ApiError) redirect(`/login?error=1&email=${encodeURIComponent(email)}`);
    throw e;
  }
  await startSession(token);
  redirect("/dashboard");
}

export async function requestPasswordReset(formData: FormData) {
  const kind = formData.get("kind") === "staff" ? "staff" : "person";
  const res = await api.requestReset(String(formData.get("email") ?? ""), kind);
  const q = new URLSearchParams({ sent: "1" });
  if (kind === "staff") q.set("side", "internal");
  if (res.link) q.set("dev", res.link); // local only: the API returns the link in dev
  redirect(`/forgot?${q}`);
}

export async function resetPassword(token: string, formData: FormData) {
  const password = String(formData.get("password") ?? "");
  if (password !== String(formData.get("confirm") ?? "")) redirect(`/reset/${token}?error=mismatch`);
  let kind: string;
  try {
    ({ kind } = await api.resetPassword(token, password));
  } catch (e) {
    if (e instanceof ApiError) redirect(`/reset/${token}?error=${encodeURIComponent(e.message)}`);
    throw e;
  }
  redirect(kind === "staff" ? "/login?side=internal&reset=1" : "/login?reset=1");
}

export async function changeMyPassword(current: string, next: string): Promise<Result> {
  try {
    const { token } = await api.changePassword(current, next);
    (await cookies()).set(SESSION_COOKIE, token, { ...COOKIE, maxAge: 12 * 60 * 60 });
    return { ok: true };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function signOutEverywhere() {
  await api.signOutEverywhere();
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/login");
}
