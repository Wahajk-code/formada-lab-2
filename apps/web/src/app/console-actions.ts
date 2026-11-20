"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import type { Result } from "@/app/actions";
import { api, ApiError, type AssistantTurn, type ThreadStep } from "@/lib/client-api";
import {
  consoleApi,
  type Evaluation,
  type LabTestBody,
  type NewMeasure,
  type OnboardingStepName,
  type PreviewResult,
  STAFF_COOKIE,
} from "@/lib/console-api";

const COOKIE = { httpOnly: true, sameSite: "lax" as const, path: "/", secure: process.env.NODE_ENV === "production" };

async function attempt<T>(fn: () => Promise<T>, paths: string[] = ["/console"]): Promise<Result<T>> {
  try {
    const data = await fn();
    for (const p of paths) revalidatePath(p, "layout");
    return { ok: true, data };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false, error: e.message };
    throw e;
  }
}

/** Local dev shortcut: pick a staff member, no password. */
export async function signInStaff(formData: FormData) {
  const { token } = await api.devStaffLogin(String(formData.get("email") ?? ""));
  (await cookies()).set(STAFF_COOKIE, token, { ...COOKIE, maxAge: 12 * 60 * 60 });
  redirect("/console");
}

/** In-app sign-in for the internal team (ADR 0023). */
export async function signInStaffWithPassword(formData: FormData) {
  const email = String(formData.get("email") ?? "");
  let token: string;
  try {
    ({ token } = await api.staffLogin(email, String(formData.get("password") ?? "")));
  } catch (e) {
    if (e instanceof ApiError) redirect(`/login?side=internal&error=1&email=${encodeURIComponent(email)}`);
    throw e;
  }
  (await cookies()).set(STAFF_COOKIE, token, { ...COOKIE, maxAge: 12 * 60 * 60 });
  redirect("/console");
}

export async function changeStaffPassword(current: string, next: string) {
  try {
    const { token } = await consoleApi.changePassword(current, next);
    (await cookies()).set(STAFF_COOKIE, token, { ...COOKIE, maxAge: 12 * 60 * 60 });
    return { ok: true as const };
  } catch (e) {
    if (e instanceof ApiError) return { ok: false as const, error: e.message };
    throw e;
  }
}

export async function staffSignOutEverywhere() {
  await consoleApi.signOutEverywhere();
  (await cookies()).delete(STAFF_COOKIE);
  redirect("/login?side=internal");
}

export async function createStaff(body: Record<string, unknown>) {
  return attempt(() => consoleApi.createStaff(body), ["/console/team"]);
}

export async function updateStaff(id: string, body: Record<string, unknown>) {
  return attempt(() => consoleApi.updateStaff(id, body), ["/console/team"]);
}

export async function signOutStaff() {
  (await cookies()).delete(STAFF_COOKIE);
  redirect("/login?side=internal");
}

export async function runWorkspaceNow(id: string) {
  return attempt(() => consoleApi.runNow(id));
}

export async function setSystemSetting(key: string, value: number) {
  return attempt(() => consoleApi.setSystem(key, value));
}

export async function resetSystemSetting(key: string) {
  return attempt(() => consoleApi.resetSystem(key));
}

export async function setWorkspaceSetting(id: string, key: string, value: number) {
  return attempt(() => consoleApi.setWorkspace(id, key, value));
}

export async function resetWorkspaceSetting(id: string, key: string) {
  return attempt(() => consoleApi.resetWorkspace(id, key));
}

export async function setRoleMetric(id: string, rmId: string, body: Record<string, unknown>) {
  return attempt(() => consoleApi.setRoleMetric(id, rmId, body));
}

export async function setMetric(id: string, metricId: string, body: Record<string, unknown>) {
  return attempt(() => consoleApi.setMetric(id, metricId, body));
}

export async function previewChange(
  id: string,
  overrides: Record<string, number>,
  roleMetrics: Record<string, Record<string, unknown>>,
): Promise<Result<PreviewResult>> {
  return attempt(() => consoleApi.preview(id, { overrides, role_metrics: roleMetrics }), []);
}

export async function setWorkspaceLlm(id: string, provider: string, model: string) {
  return attempt(() => consoleApi.setLlm(id, provider, model));
}

export async function reviewRuleAsStaff(workspaceId: string, ruleId: string, action: string, text?: string) {
  return attempt(() => consoleApi.reviewRule(workspaceId, ruleId, action, text));
}

export async function suggestSettings(workspaceId: string | null, goal: string) {
  return attempt(() => consoleApi.suggestSettings(workspaceId, goal), []);
}

export async function suggestMeasures(id: string, goal: string) {
  return attempt(() => consoleApi.suggestMeasures(id, goal), []);
}

export async function addMeasure(id: string, body: NewMeasure) {
  return attempt(() => consoleApi.addMeasure(id, body), [`/console/workspaces/${id}`]);
}

export async function draftAgentVersion(key: string, goal: string) {
  return attempt(() => consoleApi.draftAgent(key, goal), []);
}

export async function newAgentVersion(key: string, body: string, notes: string) {
  return attempt(() => consoleApi.newVersion(key, body, notes));
}

export async function updateAgent(key: string, body: Record<string, unknown>) {
  return attempt(() => consoleApi.updateAgent(key, body));
}

export async function evaluateAgent(
  key: string,
  version: number,
  workspaceId: string,
  samples: number,
): Promise<Result<Evaluation>> {
  return attempt(() => consoleApi.evaluate(key, version, workspaceId, samples), []);
}

// ---- AI onboarding (ADR 0026) ----------------------------------------------------------------

export async function createWorkspace(body: Record<string, unknown>) {
  return attempt(() => consoleApi.createWorkspace(body));
}

export async function saveConnection(
  id: string,
  body: Record<string, unknown>,
) {
  return attempt(
    () => consoleApi.saveConnection(id, body),
    [`/console/workspaces/${id}/onboarding`],
  );
}

export async function proposeOnboardingStep(
  id: string,
  step: OnboardingStepName,
  notes: string,
) {
  return attempt(
    () => consoleApi.proposeStep(id, step, notes),
    [`/console/workspaces/${id}/onboarding`],
  );
}

export async function recheckMapping(
  id: string,
  stepId: string,
  archetypes: Record<string, unknown>[],
) {
  return attempt(
    () => consoleApi.recheckMapping(id, stepId, archetypes),
    [`/console/workspaces/${id}/onboarding`],
  );
}

export async function approveOnboardingStep(
  id: string,
  stepId: string,
  keys?: string[],
  reason = "",
) {
  return attempt(
    () => consoleApi.approveStep(id, stepId, keys, reason),
    [`/console/workspaces/${id}/onboarding`, "/console"],
  );
}

// ---- Onboarding with the client (ADR 0027) ---------------------------------------------------

const ob = (id: string) => [`/console/workspaces/${id}/onboarding`, "/console"];

export async function askClient(
  id: string,
  step: ThreadStep,
  title: string,
  body: string,
) {
  return attempt(() => consoleApi.askClient(id, step, title, body), ob(id));
}

export async function replyToClient(
  id: string,
  threadId: string,
  body: string,
) {
  return attempt(() => consoleApi.replyThread(id, threadId, body), ob(id));
}

export async function resolveTeamThread(id: string, threadId: string) {
  return attempt(() => consoleApi.resolveThread(id, threadId), ob(id));
}

export async function returnOrgDraft(id: string, body: string) {
  return attempt(() => consoleApi.returnDraft(id, body), ob(id));
}

export async function goLive(id: string, invite: boolean) {
  return attempt(() => consoleApi.goLive(id, invite), ob(id));
}

export async function approveConnect(id: string, reason = "") {
  return attempt(() => consoleApi.approveConnect(id, reason), ob(id));
}

export async function approveTrial(id: string, reason = "") {
  return attempt(() => consoleApi.approveTrial(id, reason), ob(id));
}

export async function reviseProposalItem(id: string, step: string, stepId: string, key: string, instruction: string) {
  return attempt(() => consoleApi.reviseItem(id, step, stepId, key, instruction), ob(id));
}

export async function editProposalItem(id: string, step: string, stepId: string, key: string, item: Record<string, unknown>) {
  return attempt(() => consoleApi.editItem(id, step, stepId, key, item), ob(id));
}

export async function unlockProposalItem(id: string, step: string, stepId: string, key: string) {
  return attempt(() => consoleApi.unlockItem(id, step, stepId, key), ob(id));
}

export async function confirmMappingLink(id: string, stepId: string, key: string) {
  return attempt(() => consoleApi.confirmItem(id, "mapping", stepId, key), ob(id));
}

export async function reviseDiscoverySection(id: string, stepId: string, section: string, instruction: string) {
  return attempt(() => consoleApi.reviseSection(id, stepId, section, instruction), ob(id));
}

export async function lockDiscoverySection(id: string, stepId: string, section: string, lock: boolean) {
  return attempt(() => consoleApi.lockSection(id, stepId, section, lock), ob(id));
}

export async function applyRulesPreset(id: string, name: "fewer" | "balanced" | "more") {
  return attempt(() => consoleApi.applyPreset(id, name), ob(id));
}

export async function setCheckin(id: string, at: string | null, note: string, lead: string) {
  return attempt(() => consoleApi.setCheckin(id, at, note, lead), ob(id));
}

export async function refreshClientSummaries(id: string) {
  return attempt(() => consoleApi.refreshSummaries(id), ob(id));
}

export async function reopenStep(id: string, step: ThreadStep, note: string) {
  return attempt(() => consoleApi.reopenStep(id, step, note), ob(id));
}

export async function connectMockWarehouse(id: string) {
  return attempt(() => consoleApi.connectMock(id), ob(id));
}

export async function cancelOnboardingStep(id: string, step: string) {
  return attempt(() => consoleApi.cancelStep(id, step), ob(id));
}

export async function selectSnapshot(id: string, snapshotId: string) {
  return attempt(() => consoleApi.selectSnapshot(id, snapshotId), ob(id));
}

export async function resendWelcome(id: string) {
  return attempt(() => consoleApi.resendWelcome(id), ob(id));
}

export async function askWorkspaceAI(id: string, step: ThreadStep, question: string, history: AssistantTurn[], cards: string[] = []) {
  return attempt(() => consoleApi.askWorkspaceAI(id, step, question, history, cards), []);
}

export async function editDiscoveryCard(id: string, stepId: string, cardId: string, fields: Record<string, unknown>) {
  return attempt(() => consoleApi.editCard(id, stepId, cardId, fields), ob(id));
}

export async function lockDiscoveryCard(id: string, stepId: string, cardId: string, locked: boolean) {
  return attempt(() => consoleApi.lockCard(id, stepId, cardId, locked), ob(id));
}

export async function suggestCardChanges(id: string, stepId: string, cardIds: string[], instruction: string) {
  return attempt(() => consoleApi.suggestCards(id, stepId, cardIds, instruction), []);
}

export async function applyCardChanges(
  id: string,
  stepId: string,
  changes: { card_id: string; field: string; value: unknown }[],
  note: string,
  confirmLarge: boolean,
) {
  return attempt(() => consoleApi.applyCards(id, stepId, changes, note, confirmLarge), ob(id));
}

export async function editMetricsProposal(id: string, stepId: string, edits: Record<string, unknown>[]) {
  return attempt(() => consoleApi.editMetrics(id, stepId, edits), ob(id));
}

export async function loadMetricLibrary(id: string) {
  return attempt(() => consoleApi.metricLibrary(id), []);
}

export async function addLibraryMetric(id: string, stepId: string, body: { template: string; roles: string[]; name?: string }) {
  return attempt(() => consoleApi.addLibraryMetric(id, stepId, body), ob(id));
}

export async function removePlanMetric(id: string, stepId: string, key: string) {
  return attempt(() => consoleApi.removePlanMetric(id, stepId, key), ob(id));
}

export async function draftCustomMetric(id: string, body: Parameters<typeof consoleApi.draftCustomMetric>[1]) {
  return attempt(() => consoleApi.draftCustomMetric(id, body), ob(id));
}

export async function editCustomMetric(id: string, customId: string, body: { sql: string; name?: string }) {
  return attempt(() => consoleApi.editCustomMetric(id, customId, body), ob(id));
}

export async function approveCustomMetric(id: string, customId: string) {
  return attempt(() => consoleApi.approveCustomMetric(id, customId), ob(id));
}

export async function retireCustomMetric(id: string, customId: string) {
  return attempt(() => consoleApi.retireCustomMetric(id, customId), ob(id));
}

export async function editRulesProposal(id: string, stepId: string, changes: Record<string, unknown>[]) {
  return attempt(() => consoleApi.editRules(id, stepId, changes), ob(id));
}

export async function loadRun(id: string, runId: string) {
  return attempt(() => consoleApi.run(id, runId), []);
}

// ---- AI lab (dev mode) --------------------------------------------------------------------------

export async function loadLabRuns(id: string, step: string) {
  return attempt(() => consoleApi.aiLabRuns(id, step), []);
}

export async function runLabTest(id: string, step: string, body: LabTestBody) {
  return attempt(() => consoleApi.aiLabTest(id, step, body), []);
}

export async function saveLabPrompt(agentKey: string, body: string, notes: string) {
  return attempt(() => consoleApi.newVersion(agentKey, body, notes), ["/console/ai-lab"]);
}

export async function activateLabVersion(agentKey: string, version: number) {
  return attempt(() => consoleApi.updateAgent(agentKey, { active_version: version }), ["/console/ai-lab"]);
}
