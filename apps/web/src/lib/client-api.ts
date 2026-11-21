import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

export const SESSION_COOKIE = "in_session";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:8100";

export type Role = {
  id: string;
  title: string;
  department: string | null;
  permission: "owner" | "viewer";
};

export type Me = {
  person_id: string;
  name: string;
  email: string;
  app_role: "owner" | "admin" | "member";
  locale: "en" | "fr";
  tenant: { id: string; name: string; lifecycle: "onboarding" | "live" };
  roles: Role[];
  unread_notifications: number;
};

// ---- Onboarding, shared by the client app and the console (ADR 0027) ---------------------------

export type DraftNode = {
  id: string;
  title: string;
  parent_id: string | null;
  name: string;
  email: string;
  department: string;
  vacant: boolean;
  /** Extra read-only sections for the role panel (the live Org Web fills these). */
  sections?: { key: string; title: string; icon: "chart" | "file" | "sparkles"; rows?: [string, string][]; list?: string[] }[];
};

export type OrgDraft = {
  nodes: DraftNode[];
  status: "draft" | "submitted" | "approved";
  source: "blank" | "template" | "file" | "photo" | "microsoft";
  updated_at: string | null;
  updated_by: string;
  submitted_at?: string | null;
  check: { ok: boolean; errors: string[]; warnings: string[] };
};

export type ThreadStep =
  "connect" | "discovery" | "mapping" | "org" | "metrics" | "rules" | "trial";
/** The team's six steps (ADR 0030). Threads are scoped to these. */
export const ONBOARDING_STEPS: ThreadStep[] = ["connect", "discovery", "mapping", "org", "metrics", "trial"];

/** The client's five steps; each covers one or two team steps. */
export type ClientStepKey = "connect" | "prepare" | "org" | "metrics" | "live";
export const CLIENT_STEPS: ClientStepKey[] = ["connect", "prepare", "org", "metrics", "live"];

export type Thread = {
  id: string;
  step: ThreadStep;
  title: string;
  raised_by: "team" | "client";
  waiting_on: "team" | "client";
  status: "open" | "resolved";
  updated_at: string;
  messages: {
    id: string;
    side: "team" | "client";
    author: string;
    body: string;
    at: string;
  }[];
};

/** Both sides' approval of one step, with the plain summary of what was approved (ADR 0027). */
export type Signoff = {
  summary: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  team_by: string | null;
  team_at: string | null;
  client_by: string | null;
  client_at: string | null;
  reopened: number;
  reopened_at: string | null;
  reopen_note: string;
};

export type ClientStepStatus = "done" | "upcoming" | "your_input" | "waiting_on_you" | "with_formada";

export type ClientStep = {
  key: ClientStepKey;
  steps: ThreadStep[];
  status: ClientStepStatus;
  can_open: boolean;
  questions_for_you: number;
  questions_for_team: number;
};

export type Checkin = { at: string; note: string; lead: string; timezone: string };

export type ClientOnboarding =
  | { lifecycle: "onboarding" | "live"; member: true; workspace: string }
  | {
      lifecycle: "onboarding" | "live";
      member: false;
      workspace: string;
      percent: number;
      steps: ClientStep[];
      current: ClientStepKey;
      team_current: ThreadStep;
      signoffs: Partial<Record<ThreadStep, Signoff | null>>;
      go_live: { ready: boolean; blockers: string[] };
      checkin: Checkin | null;
      threads: Thread[];
      draft: OrgDraft | null;
      can_edit_draft: boolean;
      live_at: string | null;
    };

export type PresetName = "fewer" | "balanced" | "more";
export type Preset = {
  min_signal_impact: number;
  max_open_cards_per_role: number;
  top_signals_per_role: number;
};

/** "Your business, as Formada sees it": fills in as steps reach the client (ADR 0029). */
export type Business = {
  data: {
    items: number | null;
    locations: number | null;
    first_date: string | null;
    daily_since: string | null;
    linked: number;
  } | null;
  areas: { area: "stock" | "sales" | "purchasing"; level: "seen" | "partly" | "unseen" }[] | null;
  people: { count: number; titles: string[] } | null;
  watch: { count: number; names: string[] } | null;
  hear: {
    preset: "fewer" | "balanced" | "more" | null;
    floor: number;
    cards: number;
    currency: string;
  } | null;
};

/** One insight card in full, with the items behind it (ADR 0027, 0028). */
export type CardFull = {
  id: string;
  role: string;
  title: string;
  status: string;
  what: string;
  so_what: string;
  now_what: string;
  impact: number;
  impact_unit: string;
  confidence: number;
  language: "en" | "fr";
  metric: string | null;
  entity: string | null;
  signal_kind: string | null;
  current_value: number | null;
  baseline_mean: number | null;
  threshold: number | null;
  change_vs_baseline_pct: number | null;
  unit: string | null;
  series: { week: string; value: number }[];
  top_items: Record<string, string | number | null>[];
};

/** What code checked about an AI answer (ADR 0029): its sources, whether the context held the
 * answer, and the numbers it could not find in the context. */
export type AnswerCheck = { sources: string[]; grounded: "yes" | "partly" | "no"; unverified: string[] };
/** `intent` and `cards` are kept on your own messages so an edited one can be asked again the same way. */
export type AssistantTurn = {
  role: "user" | "assistant";
  text: string;
  check?: AnswerCheck;
  at?: number;
  intent?: "ask" | "suggest" | "revise";
  cards?: string[];
};
export type MetricIdea = { name: string; template: string; roles: string[]; alert: string; why: string };
export type RuleIdea = { key: string; label: string; value: number; unit: string; why: string };
export type ClientAnswer = AnswerCheck & { answer: string; metric_suggestions: MetricIdea[]; rule_suggestions: RuleIdea[] };
export type ClientTrial = {
  run: { status: string; at: string; ended_at: string | null } | null;
  cards: CardFull[];
};

export type Notifications = {
  unread: number;
  items: {
    id: string;
    kind: string;
    title: string;
    body: string;
    link: string;
    at: string;
    read: boolean;
  }[];
};


export type SeriesPoint = { week: string; value: number };

export type Evidence = {
  metric: string;
  metric_key: string;
  signal_kind?: "zscore" | "threshold" | "wow_change" | "runout";
  unit: string;
  entity: string;
  current_week: string;
  current_value: number;
  recent_mean: number;
  baseline_mean: number;
  baseline_weeks: number;
  change_vs_baseline: number;
  change_vs_baseline_pct: number | null;
  zscore: number | null;
  threshold: number | null;
  excess_over_threshold?: number | null;
  breach?: "above" | "below" | null;
  recent_weeks?: number;
  previous_value?: number;
  week_over_week_pct?: number | null;
  point_zscore?: number | null;
  exposure?: number;
  estimated_impact: number;
  impact_unit: string;
  series: SeriesPoint[];
  drivers: Record<string, Record<string, unknown>>;
  source?: { snapshot_id: string; sql: string };
};

export type Card = {
  id: string;
  role_node_id: string;
  status: string;
  title: string;
  what: string;
  so_what: string;
  now_what: string;
  decision_used: string | null;
  evidence: Evidence;
  expected_impact: string;
  impact_unit: string;
  confidence: string;
  priority: number;
  language: "en" | "fr";
  suggested_window_days: number | null;
  suggested_metric_key: string | null;
  fingerprint: string;
  generated_by: string | null;
  run_id: string | null;
  expires_at: string;
  closed_at: string | null;
  created_at: string;
};

/** Compact card used by the dashboard, ledger and history. */
export type CardBrief = {
  id: string;
  role_node_id: string;
  role: string;
  department: string | null;
  title: string;
  status: CardStatus;
  expected_impact: number;
  impact_unit: string;
  confidence: number;
  signal_kind: Evidence["signal_kind"] | null;
  metric: string | null;
  entity: string | null;
  created_at: string;
  closed_at: string | null;
};

export type CardStatus = "open" | "actioned" | "not_relevant" | "impossible" | "expired";

export type RunBrief = {
  id: string;
  type: "weekly" | "daily_check" | "remeasure" | "manual";
  status: "running" | "succeeded" | "partial" | "failed";
  started_at: string;
  ended_at: string | null;
  llm_tokens: number;
};

export type Dashboard = {
  currency: string;
  kpis: {
    open_cards: number;
    impact_at_stake: number;
    value_captured: number;
    initiatives_in_progress: number;
    initiatives_done: number;
    cards_shown_90d: number;
    actioned_rate_90d: number | null;
    not_relevant_rate_90d: number | null;
    roles_visible: number;
  };
  fates_90d: Partial<Record<CardStatus, number>>;
  by_department: { name: string; open_cards: number; impact: number }[];
  by_kind: Record<string, number>;
  by_metric: { metric: string; cards: number }[];
  weeks: { week: string; cards: number; impact: number }[];
  top_cards: CardBrief[];
  quality: ({ role_node_id: string; role: string; shown: number } & Partial<Record<CardStatus, number>>)[];
  runs: RunBrief[];
  next_weekly_run: string;
};

export type Measurement = { value: number; delta: number; value_captured: number; measured_at: string };

export type LedgerInitiative = {
  id: string;
  card: CardBrief;
  role: string;
  department: string | null;
  metric: string;
  unit: string;
  higher_is_better: boolean;
  entity: string | null;
  owner: string;
  owner_is_me: boolean;
  started_on: string;
  ends_on: string;
  window_days: number;
  progress: number;
  status: "in_progress" | "done" | "cancelled";
  keep_or_stop: "keep" | "stop" | null;
  baseline_value: number;
  baseline_period: string;
  target_value: number | null;
  midpoint: Measurement | null;
  end: Measurement | null;
  value_captured: number;
};

export type Ledger = {
  currency: string;
  total: number;
  by_department: { name: string; value: number }[];
  by_role: { name: string; value: number }[];
  initiatives: LedgerInitiative[];
};

export type HistoryCard = CardBrief & {
  feedback: { type: "not_relevant" | "impossible"; reason: string | null; by: string } | null;
  initiative: { id: string; status: string } | null;
};

export type History = { cards: HistoryCard[]; statuses: Partial<Record<CardStatus, number>> };

export type ActionDefaults = {
  card_id: string;
  metric: string;
  unit: string;
  entity: string;
  baseline_value: number;
  baseline_period: string;
  window_days: number;
  min_window_days: number;
  max_window_days: number;
};

export type Rule = {
  id: string;
  role_node_id: string;
  role: string;
  rule_type: "downweight" | "forbid";
  metric: string | null;
  text: string;
  suggested_text?: string | null;
  status: "proposed" | "active" | "retired" | "rejected";
  created_at: string;
  reviewed_at: string | null;
  sources: { card: string; type: string; reason: string | null }[];
};

export type Usage = {
  month: {
    runs: number;
    query_seconds: number;
    estimated_credits: number;
    credit_cap: number | null;
    llm_tokens: number;
    llm_model: string;
    estimated_llm_cost_usd: number | null;
  };
  schedule: { type: "weekly" | "daily_check" | "remeasure" | "digest"; next: string }[];
  runs: (RunBrief & { period_end: string; query_seconds: number; error: string | null })[];
};

export type RoleCards = { role_node_id: string; cards: Card[]; rollup: Card[] };

export type OrgRole = {
  id: string;
  title: string;
  /** From the role archetype: executive, mid or low (decides the dashboard). */
  level?: "executive" | "mid" | "low" | null;
  department_id: string | null;
  parent_id: string | null;
  holder_type: string;
  holders: string[];
  cards_route_to: string | null;
  open_cards: number;
  open_cards_subtree: number;
  value_captured_subtree: number;
  cadence: "weekly" | "daily";
  language: "en" | "fr";
  decisions_owned: string[];
  decisions_forbidden: string[];
  kpi_notes: string | null;
  metrics: { key: string; name: string; unit: string; weight: number; threshold: number | null; daily_check: boolean }[];
};

export type OrgWeb = {
  departments: { id: string; name: string; head_role_id: string | null }[];
  roles: OrgRole[];
};

export type DevUser = {
  email: string;
  name: string;
  tenant: string;
  app_role: string;
  roles: string[];
};

export type WorkspaceRole = "owner" | "admin" | "member";

export type PeopleView = {
  me: { id: string; app_role: WorkspaceRole };
  workspace: { name: string; locale: "en" | "fr"; timezone: string; hide_cards_from_roleless_admins: boolean };
  people: {
    id: string;
    name: string;
    email: string;
    app_role: WorkspaceRole;
    locale: string;
    active: boolean;
    is_me: boolean;
    assignments: { role_node_id: string; title: string; permission: "owner" | "viewer" }[];
  }[];
  roles: { id: string; title: string; department: string | null; vacant: boolean }[];
  invites: {
    id: string;
    email: string;
    name: string;
    app_role: WorkspaceRole;
    status: "pending" | "accepted" | "revoked" | "expired";
    expires_at: string;
    created_at: string;
    assignments: { role_node_id: string; permission: string; title: string }[];
  }[];
};

export type Translation = { title: string; what: string; so_what: string; now_what: string; language: string; generated_by: string | null };

export type InviteInfo = { workspace: string; email: string; name: string; app_role: WorkspaceRole; locale: "en" | "fr"; roles: number };

export type LlmProvider = {
  key: "anthropic" | "openai" | "gemini" | "fake";
  label: string;
  default_model: string;
  configured: boolean;
  key_env: string | null;
  models: { id: string; label: string; note: string }[];
};

export type LlmSettings = {
  provider: LlmProvider["key"];
  model: string;
  source: "tenant" | "default";
  updated_at: string | null;
  default: { provider: LlmProvider["key"]; model: string };
  providers: LlmProvider[];
};

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/** auth: true = token from the session cookie, a string = that token, false = no auth. */
async function request<T>(path: string, init: RequestInit = {}, auth: boolean | string = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (auth) {
    const token = typeof auth === "string" ? auth : (await cookies()).get(SESSION_COOKIE)?.value;
    if (!token) redirect("/login");
    headers.set("Authorization", `Bearer ${token}`);
  }
  const res = await fetch(`${API}${path}`, { ...init, headers, cache: "no-store" });
  if (res.status === 401 && auth) redirect("/login");
  if (!res.ok) {
    const detail = await res.json().then((b) => b?.detail, () => null);
    throw new ApiError(res.status, typeof detail === "string" ? detail : `${init.method ?? "GET"} ${path} -> ${res.status}`);
  }
  return (await res.json()) as T;
}

function publicPost<T>(path: string, body: unknown) {
  return request<T>(path, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }, false);
}

function send(method: string, path: string, body: unknown) {
  return request<Record<string, unknown>>(path, {
    method,
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

function post(path: string, body: unknown) {
  return request<Record<string, unknown>>(path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

// Layout and page both need these: one API call per request.
const currentMe = cache(() => request<Me>("/api/me"));
const currentOrg = cache(() => request<OrgWeb>("/api/org"));
const currentOnboarding = cache(() => request<ClientOnboarding>("/api/onboarding"));

export type OrgTemplate = { key: string; name: string; roles: number; about: string; shape: (number | null)[] };

export const api = {
  me: (token?: string) => (token ? request<Me>("/api/me", {}, token) : currentMe()),
  org: () => currentOrg(),
  card: (id: string) => request<Card>(`/api/cards/${id}`),
  roleCards: (roleId: string) => request<RoleCards>(`/api/roles/${roleId}/cards`),
  dashboard: () => request<Dashboard>("/api/dashboard"),
  ledger: () => request<Ledger>("/api/ledger"),
  history: (params: { role?: string; status?: string }) => {
    const q = new URLSearchParams();
    if (params.role) q.set("role_id", params.role);
    if (params.status) q.set("status", params.status);
    return request<History>(`/api/history?${q}`);
  },
  actionDefaults: (cardId: string) => request<ActionDefaults>(`/api/cards/${cardId}/action`),
  actionCard: (cardId: string, body: Record<string, unknown>) => post(`/api/cards/${cardId}/action`, body),
  feedback: (cardId: string, type: string, reason: string | null) =>
    post(`/api/cards/${cardId}/feedback`, { type, reason }),
  decide: (initiativeId: string, choice: "keep" | "stop") =>
    post(`/api/initiatives/${initiativeId}/decision`, { choice }),
  rules: () => request<{ rules: Rule[] }>("/api/admin/rules"),
  reviewRule: (ruleId: string, action: string, text?: string) =>
    request(`/api/admin/rules/${ruleId}`, {
      method: "PATCH",
      body: JSON.stringify({ action, text }),
      headers: { "Content-Type": "application/json" },
    }),
  usage: () => request<Usage>("/api/admin/usage"),
  runNow: () => post("/api/admin/runs", {}),
  people: () => request<PeopleView>("/api/workspace/people"),
  invite: (body: Record<string, unknown>) => post("/api/workspace/invites", body),
  resendInvite: (id: string) => post(`/api/workspace/invites/${id}/resend`, {}),
  revokeInvite: (id: string) => request(`/api/workspace/invites/${id}`, { method: "DELETE" }),
  setPersonRole: (id: string, appRole: string) => send("PUT", `/api/workspace/people/${id}/role`, { app_role: appRole }),
  setAssignments: (id: string, assignments: { role_node_id: string; permission: string }[]) =>
    send("PUT", `/api/workspace/people/${id}/assignments`, assignments),
  removePerson: (id: string) => request(`/api/workspace/people/${id}`, { method: "DELETE" }),
  updateWorkspace: (body: Record<string, unknown>) => send("PATCH", "/api/workspace", body),
  translate: (cardId: string, language: string) => post(`/api/cards/${cardId}/translate?language=${language}`, {}) as Promise<Translation>,
  inviteInfo: (token: string) => request<InviteInfo>(`/api/auth/invites/${token}`, {}, false),
  acceptInvite: (token: string, name: string, password: string) =>
    publicPost<{ token: string }>(`/api/auth/invites/${token}/accept`, { name, password }),
  authConfig: () => request<{ dev_login: boolean }>("/api/auth/config", {}, false),
  login: (email: string, password: string) => publicPost<{ token: string }>("/api/auth/login", { email, password }),
  staffLogin: (email: string, password: string) =>
    publicPost<{ token: string }>("/api/auth/staff-login", { email, password }),
  requestReset: (email: string, kind: "person" | "staff") =>
    publicPost<{ status: string; link?: string }>("/api/auth/password-reset", { email, kind }),
  resetPassword: (token: string, password: string) =>
    publicPost<{ status: string; kind: "person" | "staff" }>(`/api/auth/password-reset/${token}`, { password }),
  changePassword: (current: string, next: string) =>
    send("POST", "/api/auth/change-password", { current, new: next }) as Promise<{ token: string }>,
  signOutEverywhere: () => send("POST", "/api/auth/sign-out-everywhere", {}),
  onboarding: () => currentOnboarding(),
  askTeam: (step: ThreadStep, title: string, body: string) => post("/api/onboarding/threads", { step, title, body }),
  goLive: () => post("/api/onboarding/go-live", {}) as Promise<{ status: string; invited: string[] }>,
  replyThread: (id: string, body: string) => post(`/api/onboarding/threads/${id}/messages`, { body }),
  resolveThread: (id: string) => post(`/api/onboarding/threads/${id}/resolve`, {}),
  saveDraft: (nodes: DraftNode[]) => send("PUT", "/api/onboarding/org-draft", { nodes }) as Promise<OrgDraft>,
  submitDraft: () => post("/api/onboarding/org-draft/submit", {}) as Promise<OrgDraft>,
  withdrawDraft: () => post("/api/onboarding/org-draft/withdraw", {}) as Promise<OrgDraft>,
  draftTemplates: () =>
    request<{ templates: OrgTemplate[] }>("/api/onboarding/org-draft/templates"),
  importFile: (filename: string, content_b64: string) =>
    post("/api/onboarding/org-draft/import/file", { filename, content_b64 }) as Promise<OrgDraft>,
  importTemplate: (key: string) => post("/api/onboarding/org-draft/import/template", { key }) as Promise<OrgDraft>,
  microsoftUrl: () => request<{ url: string; mock: boolean }>("/api/onboarding/org-draft/microsoft"),
  importMicrosoft: (tenant: string, state: string) =>
    post("/api/onboarding/org-draft/import/microsoft", { tenant, state }) as Promise<OrgDraft>,
  notifications: () => request<Notifications>("/api/notifications"),
  askOnboardingAI: (step: ThreadStep, question: string, history: AssistantTurn[]) =>
    post("/api/onboarding/assistant", {
      step,
      question,
      history: history.map(({ role, text }) => ({ role, text })),
    }) as Promise<ClientAnswer>,
  sendSuggestions: (body: { step: "metrics" | "rules"; metrics: MetricIdea[]; rules: RuleIdea[]; note: string }) =>
    post("/api/onboarding/suggestions", body),
  onboardingTrial: () => request<ClientTrial>("/api/onboarding/trial"),
  markRead: (ids?: string[]) => post("/api/notifications/read", { ids: ids ?? null }),
  devStaff: () => request<{ email: string; name: string; staff_role: string }[]>("/api/auth/dev-staff", {}, false),
  devStaffLogin: (email: string) =>
    request<{ token: string }>(
      "/api/auth/dev-staff-login",
      { method: "POST", body: JSON.stringify({ email }), headers: { "Content-Type": "application/json" } },
      false,
    ),
  devUsers: () => request<DevUser[]>("/api/auth/dev-users", {}, false),
  devLogin: (email: string) =>
    request<{ token: string }>(
      "/api/auth/dev-login",
      { method: "POST", body: JSON.stringify({ email }), headers: { "Content-Type": "application/json" } },
      false,
    ),
};
