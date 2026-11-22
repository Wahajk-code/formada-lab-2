import "server-only";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";

import type { CardSuggestion } from "@/lib/discovery-cards";

import {
  ApiError,
  type TeamAnswer,
  type AssistantTurn,
  type CardFull,
  type OrgDraft,
  type OrgWeb,
  type Signoff,
  type Thread,
  type ThreadStep,
} from "@/lib/client-api";

/** Internal team session (ADR 0020). A separate cookie: a client session never opens the console. */
export const STAFF_COOKIE = "in_staff";
const API = process.env.API_INTERNAL_URL ?? "http://localhost:8100";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = (await cookies()).get(STAFF_COOKIE)?.value;
  if (!token) redirect("/login?side=internal");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  if (init.body) headers.set("Content-Type", "application/json");
  const res = await fetch(`${API}/api/console${path}`, {
    ...init,
    headers,
    cache: "no-store",
  });
  if (res.status === 401) redirect("/login?side=internal");
  if (!res.ok) {
    const detail = await res.json().then(
      (b) => b?.detail,
      () => null,
    );
    throw new ApiError(
      res.status,
      typeof detail === "string" ? detail : `${path} -> ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

const send = <T = Record<string, unknown>>(
  method: string,
  path: string,
  body?: unknown,
) =>
  request<T>(path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

// ---- workflows (the in-app scheduler, ADR 0034) ----------------------------------------------

export type FlowStep = {
  key: string;
  label: string;
  does: string;
  scope: "workspace" | "role";
  reads: string[];
  writes: string[];
  ai: boolean;
  on_error: "fail_run" | "fail_step" | "log";
  failure: string;
  skips: string;
  timeout_s: number;
};
export type FlowExecution = { trigger: string; status: string; started_at: string; ended_at: string | null; workspaces: number; note: string };
export type FlowRun = { run_id: string; workspace: string; workspace_id: string; status: string; started_at: string; ended_at: string | null; error: string | null };
export type FlowView = {
  key: string;
  name: string;
  purpose: string;
  run_type: string | null;
  schedule: string | null;
  schedule_note: string;
  also: string;
  paused: boolean;
  next_at: string | null;
  steps: FlowStep[];
  reads: string[];
  writes: string[];
  history: FlowExecution[];
  runs: FlowRun[];
};
/** What one step shows for one run. `none`: never reached; `waiting`: not started yet. */
export type NodeState = "waiting" | "none" | "running" | "progress" | "ok" | "skipped" | "partial" | "failed";
export type NodeInfo = { state: NodeState; done: number; total: number; ok: number; skipped: number; failed: number; running: number };
export type RunInfo = { id: string; type: string; status: string; started_at: string; ended_at: string | null; error: string | null; by_hand: boolean };
export type BoardRow = {
  workspace: { id: string; name: string };
  run: RunInfo | null;
  progress: { steps_done: number; steps_total: number; current: string | null; problems: number; roles_total: number; roles_done: number } | null;
};
export type FlowBoardData = { flow: string; workspaces: BoardRow[] };
export type RunState = {
  flow: string;
  workspace: { id: string; name: string };
  run: RunInfo;
  roles_expected: number;
  nodes: Record<string, NodeInfo>;
  roles: { id: string; title: string; steps: Record<string, string> }[];
};
export type FlowsOverview = { enabled: boolean; lab: boolean; tries: number; wait_s: number; max_runs_per_workspace: number; now: string; flows: FlowView[] };

export type StaffMe = {
  email: string;
  name: string;
  staff_role: "admin" | "developer";
  permissions: string[];
};

export type StaffUser = {
  id: string;
  email: string;
  name: string;
  staff_role: "admin" | "developer";
  active: boolean;
  has_password: boolean;
  last_login_at: string | null;
  created_at: string;
};

export type FeedbackInsights = {
  since_days: number;
  hints: { kind: "metric" | "agent"; target: string; text: string }[];
  metrics: {
    role: string;
    metric: string;
    shown: number;
    actioned: number;
    not_relevant: number;
    impossible: number;
    expired: number;
    open: number;
    not_relevant_rate: number | null;
  }[];
  entities: { role: string; entity: string; type: string; count: number }[];
  writers: {
    agent: string;
    written: number;
    rejected: number;
    rejection_rate: number | null;
    top_reason: string | null;
  }[];
  rejections: { role: string; category: string; count: number }[];
  recent: {
    role: string;
    card: string;
    type: string;
    reason: string | null;
    by: string;
    at: string;
  }[];
};

export type WorkspaceSummary = {
  id: string;
  name: string;
  plan: string;
  locale: "en" | "fr";
  timezone: string;
  currency: string;
  created_at: string;
  people: number;
  roles: number;
  open_cards: number;
  impact_at_stake: number;
  value_captured: number;
  cards_90d: number;
  actioned_rate: number | null;
  not_relevant_rate: number | null;
  last_run: { type: string; status: string; started_at: string } | null;
  failed_runs_7d: number;
  credits_month: number;
  credit_cap: number | null;
  llm_tokens_month: number;
  llm_cost_month_usd: number | null;
  llm_model: string;
  connection: string;
  rules_to_review: number;
  pending_invites: number;
  config_overrides: number;
  health: "healthy" | "attention";
  lifecycle: "onboarding" | "live";
  questions_for_team: number;
  attention: string[];
};

export type Overview = {
  totals: {
    workspaces: number;
    attention: number;
    people: number;
    open_cards: number;
    impact_at_stake: number;
    value_captured: number;
    llm_tokens_month: number;
    llm_cost_month_usd: number;
    rules_to_review: number;
  };
  workspaces: WorkspaceSummary[];
};

export type ConsoleRun = {
  id: string;
  type: string;
  status: string;
  period_end: string;
  started_at: string;
  ended_at: string | null;
  query_seconds: number;
  llm_tokens: number;
  error: string | null;
};

export type WorkspaceDetail = {
  summary: WorkspaceSummary;
  org: OrgWeb;
  runs: ConsoleRun[];
  cards: {
    id: string;
    role: string;
    title: string;
    expected_impact: number;
    impact_unit: string;
    signal_kind: string | null;
    generated_by: string | null;
    agent: string | null;
    created_at: string;
  }[];
  people: {
    id: string;
    name: string;
    email: string;
    app_role: string;
    active: boolean;
  }[];
  audit: {
    actor: string;
    action: string;
    object_type: string;
    at: string;
    detail: Record<string, unknown>;
  }[];
};

export type Scorecard = {
  verdict: "pass" | "warn" | "fail";
  checks: { key: string; status: "pass" | "warn" | "fail"; title: string; detail: string; fix: string }[];
  numbers: { cards: number; signals: number; dropped: number; rejections: number; tokens: number | null };
};

export type RunDetail = {
  run: ConsoleRun & { n8n_execution_id: string | null };
  scorecard: Scorecard;
  steps: {
    role: string;
    step: string;
    status: string;
    attempts: number;
    detail: Record<string, unknown>;
    started_at: string;
    finished_at: string | null;
  }[];
  calls: {
    role: string;
    provider: string;
    model: string;
    status: string;
    agent: string | null;
    input_tokens: number;
    output_tokens: number;
    latency_ms: number;
    cost_usd: number | null;
    error: string | null;
    prompt: { system: string; user: string };
    response: string | null;
  }[];
  signals: {
    role: string;
    kind: string;
    entity: string;
    status: string;
    reason: string | null;
    impact: number;
    zscore: number | null;
  }[];
  rejections: { role: string; title: string | null; reasons: string[] }[];
  cards: CardFull[];
};

export type Setting = {
  key: string;
  group: string;
  label: string;
  /** One plain sentence (shown first); help is the detail (ADR 0029). */
  simple: string;
  help: string;
  unit: string;
  min: number;
  max: number;
  integer: boolean;
  default: number;
  system: number | null;
  workspace: number | null;
  effective: number;
  source: "default" | "system" | "workspace";
};

export type RoleMetricRow = {
  id: string;
  role: string;
  metric: string;
  metric_key: string;
  unit: string;
  higher_is_better: boolean;
  weight: number;
  threshold: number | null;
  daily_check: boolean;
};

export type MetricRow = {
  id: string;
  key: string;
  name: string;
  unit: string;
  unit_value: number;
  higher_is_better: boolean;
  is_active: boolean;
  template: string;
};

export type WorkspaceConfig = {
  groups: string[];
  settings: Setting[];
  role_metrics: RoleMetricRow[];
  metrics: MetricRow[];
};

export type ConfigChange = {
  scope: string;
  key: string;
  old: unknown;
  new: unknown;
  actor: string;
  at: string;
  workspace: string | null;
};

export type PreviewResult = {
  run_id: string;
  period_end: string;
  roles: {
    role: string;
    before: number;
    after: number;
    kept: number;
    added: { entity: string; metric: string; kind: string; impact: number }[];
    removed: { entity: string; metric: string; kind: string; impact: number }[];
  }[];
};

export type AgentStats = {
  cards: number;
  actioned: number;
  not_relevant: number;
  impossible: number;
  expired: number;
  open: number;
  rejected: number;
  action_rate: number | null;
  not_relevant_rate: number | null;
  rejection_rate: number | null;
  calls: number;
  tokens: number;
};

export type AgentSummary = {
  key: string;
  name: string;
  kind: "card_writer" | "translator" | "rule_drafter" | "onboarding" | (string & {});
  playbook: string | null;
  description: string;
  active_version: number;
  versions: number;
  model_override: string | null;
  use_examples: boolean;
  stats: AgentStats;
};

export type AgentDetail = Omit<AgentSummary, "versions" | "stats"> & {
  versions: {
    version: number;
    body: string;
    notes: string;
    created_by: string;
    created_at: string;
    active: boolean;
    stats: AgentStats;
  }[];
};

export type Evaluation = {
  agent: string;
  version: number;
  active_version: number;
  model: string;
  evaluated_at: string;
  totals: Record<string, number>;
  cases: {
    role: string;
    run_id: string;
    error: string | null;
    baseline: { title: string; reasons: string[] }[];
    candidate: { title: string; now_what: string; reasons: string[] }[];
  }[];
};

export type ConsoleRule = {
  id: string;
  role: string;
  rule_type: "downweight" | "forbid";
  metric: string | null;
  text: string;
  suggested_text: string | null;
  status: "proposed" | "active" | "retired" | "rejected";
  created_at: string;
  reviewed_at: string | null;
  sources: { card: string; type: string; reason: string | null }[];
  workspace_id: string;
  workspace: string;
};

export type LlmView = {
  provider: string;
  model: string;
  source: "tenant" | "default";
  updated_at: string | null;
  default: { provider: string; model: string };
  providers: {
    key: string;
    label: string;
    default_model: string;
    configured: boolean;
    key_env: string | null;
    models: { id: string; label: string; note: string }[];
  }[];
};

// ---- AI onboarding (ADR 0026) ----------------------------------------------------------------

export type OnboardingStepName =
  "discovery" | "mapping" | "org" | "metrics" | "rules";

export type CheckResult = { ok: boolean; errors: string[]; warnings: string[] };

export type OnboardingStep = {
  id: string;
  step: OnboardingStepName;
  status: "running" | "proposed" | "approved" | "failed" | "superseded";
  output: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  checks: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  notes: string;
  agent: string | null;
  model: string | null;
  tokens: { input: number; output: number };
  cost_usd: number | null;
  latency_ms: number;
  error: string | null;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  applied: Record<string, unknown> | null;
  input_summary: { bytes: number; keys: string[] };
};

export type OnboardingState = {
  workspace: {
    id: string;
    name: string;
    currency: string;
    timezone: string;
    locale: string;
    owner: { name: string; email: string } | null;
    llm: string | null;
  };
  /** Local only: the console offers a one-click mock warehouse connection. */
  mock_connection: boolean;
  /** Lab only: the saved warehouse snapshots discovery can replay. */
  lab: {
    items: {
      id: string;
      database: string | null;
      tables: number;
      views: number;
      guide: string | null;
      summary: string;
      approved: boolean;
      saved_at: string;
      recommended: boolean;
    }[];
    selected: string | null;
  } | null;
  connection: {
    account_identifier: string;
    user_name: string;
    role_name: string;
    warehouse_name: string;
    database_name: string;
    schemas: string[];
    secret_ref: string;
    monthly_credit_cap: number;
    status: "pending" | "ok" | "failed";
    test_result: { ok: boolean; error?: string } | null;
    last_tested_at: string | null;
  } | null;
  done: Record<"connect" | OnboardingStepName, boolean>;
  steps: Partial<Record<OnboardingStepName, OnboardingStep>>;
  history: Record<
    OnboardingStepName,
    { id: string; status: string; created_at: string }[]
  >;
  mappings: { archetype: string; source: string; fields: number }[];
  org: {
    departments: { name: string; playbook: string | null }[];
    roles: {
      id: string;
      title: string;
      archetype: string | null;
      parent: string | null;
      holder_type: string;
    }[];
  };
  metrics: {
    key: string;
    name: string;
    template: string;
    unit: string;
    higher_is_better: boolean;
    unit_value: number;
    roles: {
      role: string;
      weight: number;
      threshold: number | null;
      daily_check: boolean;
    }[];
  }[];
  rules: { key: string; value: number }[];
  // ADR 0027: shared progress, questions with the client, their org draft, go-live.
  lifecycle: "onboarding" | "live";
  live_at: string | null;
  progress: {
    steps: TeamStep[];
    current: ThreadStep;
    percent: number;
    blockers: string[];
    /** Why the team cannot approve each step now (null = it can). */
    can_approve: Record<ThreadStep, string | null>;
  };
  signoffs: Record<ThreadStep, Signoff | null>;
  threads: Thread[];
  draft: OrgDraft;
  trial: {
    run_id: string;
    status: string;
    type: string;
    at: string;
    cards: number;
  } | null;
  checkin: import("@/lib/client-api").Checkin | null;
  /** Review by exception (ADR 0029): code-computed checks, the client's decision line, timing. */
  review: {
    checklists: Record<ThreadStep, ReviewCheck[]>;
    decisions: Partial<Record<ThreadStep, string>>;
    timing: Record<
      ThreadStep,
      {
        opened_at: string | null;
        team_minutes: number | null;
        client_minutes: number | null;
        questions: number;
      }
    >;
  };
};

/** AI help in the console: suggestions a person applies and saves (ADR 0029). */
export type SettingsAdvice = {
  summary: string;
  suggestions: { key: string; label: string; value: number; now: number; unit: string; why: string }[];
};
export type MeasureAdvice = {
  summary: string;
  suggestions: { template: string; name: string; roles: string[]; alert: string; why: string }[];
};
export type NewMeasure = {
  template: string;
  name: string;
  unit: string;
  higher_is_better: boolean;
  unit_value: number;
  roles: { role_id: string; weight: number; threshold: number | null; daily_check: boolean }[];
};

/** A targeted edit made a new proposal; the item's own checks ran again (ADR 0029). */
export type ItemResult = { status: string; step_id: string; item: string; errors: string[]; warnings: string[] };

export type ReviewCheck = {
  key: string;
  ok: boolean;
  /** Worth a look, but approving past it needs no reason. */
  soft: boolean;
  title: string;
  detail: string;
  fix: string;
};

export type TeamStepStatus =
  | "done"
  | "client_review"
  | "working"
  | "waiting"
  | "review"
  | "failed"
  | "locked"
  | "todo";

export type TeamStep = {
  key: ThreadStep;
  status: TeamStepStatus;
  team_approved: boolean;
  client_approved: boolean;
  questions_for_team: number;
  questions_for_client: number;
};

// The onboarding layout and step page both need the state: one API call per request.
const onboardingState = cache((id: string) =>
  request<OnboardingState>(`/workspaces/${id}/onboarding`),
);

/** Reference for the onboarding step pages (ADR 0027). */
export type LibraryMetric = {
  key: string;
  archetype: string;
  name: { en: string; fr?: string };
  why: { en?: string; fr?: string };
  template: string | null;
  needs: string[];
  status: "found" | "not_found";
  reason: "" | "no_template" | "not_mapped" | "field_empty";
  missing: string[];
  message: string;
  unit: string;
  higher_is_better: boolean | null;
  state: "in_plan" | "removed" | "available";
};

export type CustomMetric = {
  id: string;
  key: string;
  version: number;
  name: string;
  playbook: string;
  description: string;
  instructions: string;
  archetypes: string[];
  origin: "hand" | "ai";
  status: "draft" | "approved" | "retired";
  sql: string;
  dry_run: { ok: boolean; error?: string; entities?: number; weeks?: number; rows?: number } | null;
  created_by: string;
  approved_by: string | null;
  state?: "in_plan" | "available";
};

export type MetricLibrary = {
  summary: { total: number; found: number; not_found: number };
  archetypes: {
    archetype: string;
    mapped: boolean;
    summary: { total: number; found: number; not_found: number };
    metrics: LibraryMetric[];
  }[];
  custom: CustomMetric[];
};

export type OnboardingGuide = {
  profile: {
    database: string | null;
    tables: {
      table: string;
      rows: number | null;
      columns: { column: string; type: string; fill_pct: number | null; distinct: number | null }[];
    }[];
  };
  /** Customer semantic views (names, formulas, comments; no rows). */
  semantic_views?: {
    view: string;
    comment: string;
    tables: {
      table: string;
      base_table: string | null;
      comment: string;
      measured?: { first_date?: string; last_date?: string; [k: string]: unknown } | null;
      dimensions: { name: string; type: string | null; comment: string }[];
      metrics: { name: string; expression: string; comment: string }[];
    }[];
    relationships: string[];
  }[];
  time_profile?: {
    date_column: string | null;
    entity_columns: string[];
    cadence: { from: string; to: string; step_days: number; count: number }[];
    breaks: { from: string; to: string; rows?: number[] }[];
    filled_late: { column: string; first_date: string }[];
    dates: { date: string; rows: number }[];
  };
  categories?: { column: string; values: { value: string; rows: number }[] }[];
  key_overlaps?: { left: string; right: string; left_codes: number; right_codes: number; shared: number; pct_of_right: number }[];
  /** Joins code tested on the data (TABLE.COLUMN ends, share of values that match). */
  tested_joins?: { source: string; target: string; values?: number; confirmed?: boolean; matched_pct?: number; orphan_values?: number }[];
  archetypes: { archetype: string; description: string; fields: { field: string; meaning: string }[] }[];
  role_archetypes: {
    key: string;
    playbook: string | null;
    title: string | null;
    decisions_owned: string[];
    decisions_forbidden: string[];
    kpi_notes: string | null;
  }[];
  rule_settings: { key: string; label: string; help: string; group: string; minimum: number; maximum: number; unit: string }[];
};

export type OnboardingBoardRow = {
  id: string;
  name: string;
  created_at: string;
  owner: string | null;
  percent: number;
  current: ThreadStep;
  status: TeamStepStatus;
  steps: { key: ThreadStep; status: TeamStepStatus }[];
  questions_for_team: number;
  questions_for_client: number;
  waiting_on: "team" | "client";
  last_activity: string | null;
};

/* eslint-disable @typescript-eslint/no-explicit-any -- agent inputs and answers are schema-checked JSON */
export type LabVersion = { version: number; notes: string; created_by: string; chars: number; active: boolean };
export type LabCriterion = { kind: string; name: string; text: string };
export type LabStep = {
  step: string;
  title: string;
  job: string;
  agent: string;
  agent_name: string;
  active_version: number | null;
  model_override: string | null;
  versions: LabVersion[];
  criteria: LabCriterion[];
  output_schema: Record<string, any>;
};
export type LabOverview = { steps: LabStep[]; efforts: string[] };
export type LabRun = {
  id: string;
  status: string;
  created_at: string;
  created_by: string;
  agent: string | null;
  agent_version: number | null;
  model: string | null;
  effort: string | null;
  tokens: { input: number; output: number };
  cost_usd: number | null;
  latency_ms: number;
  error: string | null;
  thinking: string;
  notes: string;
  system_prompt: string | null;
  input: any;
  output: any;
  checks: any;
};
export type LabRuns = { step: string; runs: LabRun[] };
export type LabTestBody = { version?: number; prompt?: string; notes?: string; input?: any; model?: string; effort?: string };
export type LabTestResult = {
  step: string;
  prompt: string;
  model: string;
  effort: string;
  tokens: { input: number; output: number };
  cost_usd: number | null;
  latency_ms: number;
  error: string | null;
  thinking: string;
  raw: string | null;
  output: any;
  checks: any;
  audit: { score: number; items: { name: string; points: number; max: number; note: string }[] } | null;
  shape: Record<string, number>;
  baseline_shape: Record<string, number>;
  by: string;
};

export const consoleApi = {
  me: () => request<StaffMe>("/me"),
  overview: () => request<Overview>("/overview"),
  workspace: (id: string) => request<WorkspaceDetail>(`/workspaces/${id}`),
  run: (id: string, runId: string) =>
    request<RunDetail>(`/workspaces/${id}/runs/${runId}`),
  runNow: (id: string) => send("POST", `/workspaces/${id}/run`),
  flows: () => request<FlowsOverview>("/flows"),
  flowBoard: (key: string) => request<FlowBoardData>(`/flows/${key}/board`),
  flowRunState: (tenantId: string, runId: string) => request<RunState>(`/flows/runs/${tenantId}/${runId}`),
  pauseFlow: (key: string) => send("POST", `/flows/${key}/pause`, {}),
  resumeFlow: (key: string) => send("POST", `/flows/${key}/resume`, {}),
  runFlow: (key: string, tenantId: string | null) => send("POST", `/flows/${key}/run`, { tenant_id: tenantId }),
  suggestSettings: (workspaceId: string | null, goal: string) =>
    send<SettingsAdvice>("POST", workspaceId ? `/workspaces/${workspaceId}/config/suggest` : "/config/suggest", { goal }),
  suggestMeasures: (id: string, goal: string) =>
    send<MeasureAdvice>("POST", `/workspaces/${id}/metrics/suggest`, { goal }),
  measureTemplates: (id: string) =>
    request<{ templates: { key: string; description: string; playbook: string }[] }>(`/workspaces/${id}/metrics/templates`),
  addMeasure: (id: string, body: NewMeasure) => send<{ status: string; metric: string }>("POST", `/workspaces/${id}/metrics`, body),
  draftAgent: (key: string, goal: string) =>
    send<{ body: string; notes: string; from_version: number }>("POST", `/agents/${key}/draft`, { goal }),
  systemConfig: () =>
    request<{ groups: string[]; settings: Setting[] }>("/config"),
  setSystem: (key: string, value: number) =>
    send("PUT", `/config/${key}`, { value }),
  resetSystem: (key: string) => send("DELETE", `/config/${key}`),
  workspaceConfig: (id: string) =>
    request<WorkspaceConfig>(`/workspaces/${id}/config`),
  setWorkspace: (id: string, key: string, value: number) =>
    send("PUT", `/workspaces/${id}/config/${key}`, { value }),
  resetWorkspace: (id: string, key: string) =>
    send("DELETE", `/workspaces/${id}/config/${key}`),
  setRoleMetric: (id: string, rmId: string, body: Record<string, unknown>) =>
    send("PATCH", `/workspaces/${id}/role-metrics/${rmId}`, body),
  setMetric: (id: string, metricId: string, body: Record<string, unknown>) =>
    send("PATCH", `/workspaces/${id}/metrics/${metricId}`, body),
  preview: (
    id: string,
    body: {
      overrides: Record<string, number>;
      role_metrics: Record<string, Record<string, unknown>>;
    },
  ) => send<PreviewResult>("POST", `/workspaces/${id}/preview`, body),
  history: (workspaceId?: string) =>
    request<ConfigChange[]>(
      `/history${workspaceId ? `?workspace_id=${workspaceId}` : ""}`,
    ),
  llm: (id: string) => request<LlmView>(`/workspaces/${id}/llm`),
  setLlm: (id: string, provider: string, model: string) =>
    send<LlmView>("PUT", `/workspaces/${id}/llm`, { provider, model }),
  rules: (status?: string) =>
    request<ConsoleRule[]>(`/rules${status ? `?status=${status}` : ""}`),
  reviewRule: (
    workspaceId: string,
    ruleId: string,
    action: string,
    text?: string,
  ) =>
    send("PATCH", `/workspaces/${workspaceId}/rules/${ruleId}`, {
      action,
      text,
    }),
  agents: () => request<{ agents: AgentSummary[] }>("/agents"),
  agent: (key: string) => request<AgentDetail>(`/agents/${key}`),
  newVersion: (key: string, body: string, notes: string) =>
    send("POST", `/agents/${key}/versions`, { body, notes }),
  updateAgent: (key: string, body: Record<string, unknown>) =>
    send("PATCH", `/agents/${key}`, body),
  feedback: (id: string) =>
    request<FeedbackInsights>(`/workspaces/${id}/feedback`),
  staff: () => request<StaffUser[]>("/staff"),
  createStaff: (body: Record<string, unknown>) =>
    send<StaffUser>("POST", "/staff", body),
  updateStaff: (id: string, body: Record<string, unknown>) =>
    send<StaffUser>("PATCH", `/staff/${id}`, body),
  changePassword: (current: string, next: string) =>
    send<{ token: string }>("POST", "/account/password", {
      current,
      new: next,
    }),
  signOutEverywhere: () => send("POST", "/account/sign-out-everywhere", {}),
  createWorkspace: (body: Record<string, unknown>) =>
    send<{ status: string; id: string }>("POST", "/workspaces", body),
  onboarding: (id: string) => onboardingState(id),
  saveConnection: (id: string, body: Record<string, unknown>) =>
    send<{ status: string; ok: boolean; error?: string }>(
      "PUT",
      `/workspaces/${id}/onboarding/connection`,
      body,
    ),
  proposeStep: (id: string, step: OnboardingStepName, notes: string) =>
    send<{ status: string; step_id: string }>(
      "POST",
      `/workspaces/${id}/onboarding/${step}`,
      { notes },
    ),
  recheckMapping: (
    id: string,
    stepId: string,
    archetypes: Record<string, unknown>[],
  ) =>
    send<{ status: string; step_id: string }>(
      "POST",
      `/workspaces/${id}/onboarding/mapping/${stepId}/recheck`,
      { archetypes },
    ),
  approveStep: (id: string, stepId: string, keys?: string[], reason = "") =>
    send<{ status: string; applied: Record<string, unknown> }>(
      "POST",
      `/workspaces/${id}/onboarding/steps/${stepId}/approve`,
      { keys: keys ?? null, reason },
    ),
  askClient: (id: string, step: ThreadStep, title: string, body: string) =>
    send("POST", `/workspaces/${id}/onboarding/threads`, { step, title, body }),
  replyThread: (id: string, threadId: string, body: string) =>
    send("POST", `/workspaces/${id}/onboarding/threads/${threadId}/messages`, {
      body,
    }),
  resolveThread: (id: string, threadId: string) =>
    send(
      "POST",
      `/workspaces/${id}/onboarding/threads/${threadId}/resolve`,
      {},
    ),
  returnDraft: (id: string, body: string) =>
    send("POST", `/workspaces/${id}/onboarding/org-draft/return`, { body }),
  resendWelcome: (id: string) => send<{ status: string; to: string; link?: string }>("POST", `/workspaces/${id}/welcome`, {}),
  onboardingGuide: (id: string) => request<OnboardingGuide>(`/workspaces/${id}/onboarding/guide`),
  askWorkspaceAI: (id: string, step: ThreadStep, question: string, history: AssistantTurn[], cards: string[] = []) =>
    send<TeamAnswer>("POST", `/workspaces/${id}/onboarding/assistant`, {
      step,
      question,
      history: history.map(({ role, text }) => ({ role, text })),
      cards,
    }),
  editCard: (id: string, stepId: string, cardId: string, fields: Record<string, unknown>) =>
    send<{ status: string; step_id: string; card_id: string; locked: boolean }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/cards/edit`, { card_id: cardId, fields }),
  lockCard: (id: string, stepId: string, cardId: string, locked: boolean) =>
    send<{ status: string; step_id: string; locked: boolean }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/cards/lock`, { card_id: cardId, locked }),
  removeJoin: (id: string, stepId: string, cardId: string) =>
    send<{ status: string; step_id: string }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/cards/remove-join`, { card_id: cardId }),
  addJoin: (id: string, stepId: string, table: string, column: string, referencesTable: string, referencesColumn: string) =>
    send<{ status: string; step_id: string; card_id: string }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/cards/add-join`, { table, column, references_table: referencesTable, references_column: referencesColumn }),
  suggestCards: (id: string, stepId: string, cardIds: string[], instruction: string) =>
    send<CardSuggestion>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/cards/suggest`, { card_ids: cardIds, instruction }),
  applyCards: (id: string, stepId: string, changes: { card_id: string; field: string; value: unknown }[], note: string, confirmLarge: boolean) =>
    send<{ status: string; step_id: string }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/cards/apply`, { changes, note, confirm_large: confirmLarge }),
  aiLab: (workspaceId?: string) => request<LabOverview>(`/ai-lab${workspaceId ? `?workspace_id=${workspaceId}` : ""}`),
  aiLabRuns: (id: string, step: string) => request<LabRuns>(`/workspaces/${id}/ai-lab/${step}`),
  aiLabTest: (id: string, step: string, body: LabTestBody) =>
    send<LabTestResult>("POST", `/workspaces/${id}/ai-lab/${step}/test`, body),
  metricLibrary: (id: string) => request<MetricLibrary>(`/workspaces/${id}/onboarding/metric-library`),
  addLibraryMetric: (id: string, stepId: string, body: { template: string; roles: string[]; name?: string }) =>
    send<{ status: string; step_id: string }>("POST", `/workspaces/${id}/onboarding/metrics/${stepId}/add`, body),
  removePlanMetric: (id: string, stepId: string, key: string) =>
    send<{ status: string; step_id: string }>("DELETE", `/workspaces/${id}/onboarding/metrics/${stepId}/metric/${key}`),
  draftCustomMetric: (
    id: string,
    body: { name: string; archetypes: string[]; instructions?: string; sql?: string; unit?: string; higher_is_better?: boolean; playbook?: string },
  ) => send<CustomMetric>("POST", `/workspaces/${id}/onboarding/custom-metrics`, body),
  editCustomMetric: (id: string, customId: string, body: { sql: string; name?: string }) =>
    send<CustomMetric>("PUT", `/workspaces/${id}/onboarding/custom-metrics/${customId}`, body),
  approveCustomMetric: (id: string, customId: string) =>
    send<CustomMetric>("POST", `/workspaces/${id}/onboarding/custom-metrics/${customId}/approve`),
  retireCustomMetric: (id: string, customId: string) =>
    send<CustomMetric>("DELETE", `/workspaces/${id}/onboarding/custom-metrics/${customId}`),
  editMetrics: (id: string, stepId: string, edits: Record<string, unknown>[]) =>
    send<{ status: string; step_id: string }>("POST", `/workspaces/${id}/onboarding/metrics/${stepId}/edit`, { edits }),
  editRules: (id: string, stepId: string, changes: Record<string, unknown>[]) =>
    send<{ status: string; step_id: string }>("POST", `/workspaces/${id}/onboarding/rules/${stepId}/edit`, { changes }),
  onboardingBoard: () =>
    request<{ workspaces: OnboardingBoardRow[] }>("/onboarding"),
  connectMock: (id: string) =>
    send<{ status: string; ok: boolean; error?: string }>(
      "POST",
      `/workspaces/${id}/onboarding/connection/mock`,
      {},
    ),
  cancelStep: (id: string, step: string) =>
    send<{ status: string; stopped: number }>("POST", `/workspaces/${id}/onboarding/${step}/cancel`, {}),
  selectSnapshot: (id: string, snapshotId: string) =>
    send<{ status: string; selected: string }>("POST", `/workspaces/${id}/onboarding/snapshot`, {
      snapshot_id: snapshotId,
    }),
  approveConnect: (id: string, reason = "") =>
    send("POST", `/workspaces/${id}/onboarding/connect/approve`, { reason }),
  approveTrial: (id: string, reason = "") =>
    send("POST", `/workspaces/${id}/onboarding/trial/approve`, { reason }),
  reviseItem: (id: string, step: string, stepId: string, key: string, instruction: string) =>
    send<ItemResult>("POST", `/workspaces/${id}/onboarding/${step}/${stepId}/items/${encodeURIComponent(key)}/revise`, { instruction }),
  editItem: (id: string, step: string, stepId: string, key: string, item: Record<string, unknown>) =>
    send<ItemResult>("PUT", `/workspaces/${id}/onboarding/${step}/${stepId}/items/${encodeURIComponent(key)}`, { item }),
  unlockItem: (id: string, step: string, stepId: string, key: string) =>
    send<ItemResult>("POST", `/workspaces/${id}/onboarding/${step}/${stepId}/items/${encodeURIComponent(key)}/unlock`, {}),
  confirmItem: (id: string, step: string, stepId: string, key: string) =>
    send<ItemResult>("POST", `/workspaces/${id}/onboarding/${step}/${stepId}/items/${encodeURIComponent(key)}/confirm`, {}),
  reviseSection: (id: string, stepId: string, section: string, instruction: string) =>
    send<{ status: string; step_id: string; section: string }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/sections/${section}/revise`, { instruction }),
  lockSection: (id: string, stepId: string, section: string, lock: boolean) =>
    send<{ status: string; step_id: string; section: string }>("POST", `/workspaces/${id}/onboarding/discovery/${stepId}/sections/${section}/${lock ? "lock" : "unlock"}`, {}),
  applyPreset: (id: string, name: "fewer" | "balanced" | "more") =>
    send<{ status: string; values: Record<string, number> }>("POST", `/workspaces/${id}/rules/preset`, { name }),
  setCheckin: (id: string, at: string | null, note: string, lead: string) =>
    send<{ status: string }>("PUT", `/workspaces/${id}/onboarding/checkin`, { at, note, lead }),
  refreshSummaries: (id: string) =>
    send<{ status: string; refreshed: string[] }>(
      "POST",
      `/workspaces/${id}/onboarding/summaries/refresh`,
      {},
    ),
  reopenStep: (id: string, step: ThreadStep, note: string) =>
    send("POST", `/workspaces/${id}/onboarding/reopen/${step}`, { note }),
  goLive: (id: string, invite: boolean) =>
    send<{
      status: string;
      invited: string[];
      skipped: { email: string; reason: string }[];
    }>("POST", `/workspaces/${id}/go-live`, { invite }),
  evaluate: (
    key: string,
    version: number,
    workspaceId: string,
    samples: number,
  ) =>
    send<Evaluation>("POST", `/agents/${key}/evaluate`, {
      version,
      workspace_id: workspaceId,
      samples,
    }),
};
