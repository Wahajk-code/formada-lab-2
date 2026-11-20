"use server";

import { revalidatePath } from "next/cache";

import type { Result } from "@/app/actions";
import {
  api,
  ApiError,
  type DraftNode,
  type OrgDraft,
  type ThreadStep,
  type AssistantTurn,
  type ClientAnswer,
  type MetricIdea,
  type RuleIdea,
} from "@/lib/client-api";

async function attempt<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    const data = await fn();
    revalidatePath("/onboarding", "layout");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function askTeam(step: ThreadStep, title: string, body: string) {
  return attempt(() => api.askTeam(step, title, body));
}

export async function goLive() {
  return attempt(() => api.goLive());
}

export async function replyToTeam(threadId: string, body: string) {
  return attempt(() => api.replyThread(threadId, body));
}

export async function resolveClientThread(threadId: string) {
  return attempt(() => api.resolveThread(threadId));
}

/** Autosave from the builder: no revalidation, the builder keeps its own state. */
export async function saveOrgDraft(
  nodes: DraftNode[],
): Promise<Result<OrgDraft>> {
  try {
    return { ok: true, data: await api.saveDraft(nodes) };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function submitOrgDraft() {
  return attempt(() => api.submitDraft());
}

export async function withdrawOrgDraft() {
  return attempt(() => api.withdrawDraft());
}

export async function importOrgFile(form: FormData) {
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0)
    return { ok: false, error: "Choose a file" } as Result<OrgDraft>;
  const b64 = Buffer.from(await file.arrayBuffer()).toString("base64");
  return attempt(() => api.importFile(file.name, b64));
}

export async function importOrgTemplate(key: string) {
  return attempt(() => api.importTemplate(key));
}

export async function microsoftConsentUrl() {
  return attempt(() => api.microsoftUrl());
}

export async function importMicrosoft(tenant: string, state: string) {
  return attempt(() => api.importMicrosoft(tenant, state));
}

export async function markNotificationsRead(ids?: string[]) {
  try {
    await api.markRead(ids);
    revalidatePath("/", "layout");
    return { ok: true } as Result;
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message } as Result;
    throw e;
  }
}

export async function askOnboardingAI(step: ThreadStep, question: string, history: AssistantTurn[]) {
  try {
    return { ok: true, data: await api.askOnboardingAI(step, question, history) } as Result<ClientAnswer>;
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message } as Result<ClientAnswer>;
    throw e;
  }
}

export async function sendSuggestions(body: {
  step: "metrics" | "rules";
  metrics: MetricIdea[];
  rules: RuleIdea[];
  note: string;
}) {
  return attempt(() => api.sendSuggestions(body));
}
