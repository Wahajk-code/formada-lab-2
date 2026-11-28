import { ArrowLeft, ArrowUpRight } from "lucide-react";
import Link from "next/link";

import { Stat } from "@/components/charts/stat";
import { ConfigEditor } from "@/components/console/config-editor";
import { AccuracyView } from "@/components/console/accuracy";
import { FeedbackInsightsView } from "@/components/console/feedback-insights";
import { ListFilter } from "@/components/console/list-filter";
import { LlmForm } from "@/components/console/llm-form";
import { MeasureManager } from "@/components/console/measure-manager";
import { RunButton } from "@/components/console/run-button";
import { OrgGraph } from "@/components/org/org-graph";
import type { LlmSettings } from "@/lib/client-api";
import { consoleApi } from "@/lib/console-api";
import { matches, newestFirst } from "@/lib/list-filter";
import { cn } from "@/lib/utils";

const TABS = ["overview", "org", "runs", "cards", "feedback", "accuracy", "config", "ai", "people", "activity"] as const;
type Tab = (typeof TABS)[number];
const LABEL: Record<Tab, string> = {
  overview: "Overview",
  org: "Org web",
  runs: "Runs",
  cards: "Open cards",
  feedback: "Feedback",
  accuracy: "Accuracy",
  config: "Config & rules",
  ai: "AI model",
  people: "People",
  activity: "Activity",
};

const money = (v: number, c = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: c, notation: "compact", maximumFractionDigits: 1 }).format(v);
const when = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Toronto" }).format(new Date(iso));

function Pill({ value }: { value: string }) {
  const strong = ["failed", "partial", "running", "attention"].includes(value);
  return <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", strong ? "bg-brand text-brand-foreground" : "bg-surface-strong")}>{value}</span>;
}

export default async function WorkspacePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string; q?: string; type?: string; status?: string; role?: string }>;
}) {
  const [{ id }, { tab: raw, q, type, status, role }] = await Promise.all([params, searchParams]);
  const tab: Tab = TABS.includes(raw as Tab) ? (raw as Tab) : "overview";
  const [ws, me] = await Promise.all([consoleApi.workspace(id), consoleApi.me()]);
  const can = (p: string) => me.permissions.includes(p);
  const s = ws.summary;

  let body: React.ReactNode = null;
  if (tab === "overview") {
    body = (
      <div className="space-y-6">
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <Stat hero label="Impact at stake" value={money(s.impact_at_stake, s.currency)} hint={`${s.open_cards} open cards`} />
          <Stat label="Value captured" value={money(s.value_captured, s.currency)} hint="End measurements" delay={60} />
          <Stat
            label="Card fate (90 days)"
            value={s.actioned_rate === null ? "–" : `${Math.round(s.actioned_rate * 100)}% actioned`}
            hint={s.not_relevant_rate === null ? "No feedback yet" : `${Math.round(s.not_relevant_rate * 100)}% Not relevant · ${s.cards_90d} cards`}
            delay={120}
          />
          <Stat label="This month" value={`${s.credits_month.toFixed(3)} cr`} hint={`cap ${s.credit_cap ?? "–"} · ${s.llm_tokens_month.toLocaleString("en-CA")} AI tokens`} delay={180} />
        </div>
        <section className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-2xl bg-surface p-5 shadow-card">
            <h2 className="mb-3 text-sm font-semibold">Health</h2>
            {s.attention.length ? (
              <ul className="space-y-2 text-sm">
                {s.attention.map((a) => <li key={a} className="rounded-lg bg-brand/10 px-3 py-2 text-brand">{a}</li>)}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">Nothing needs attention.</p>
            )}
            <dl className="mt-4 grid grid-cols-2 gap-3 text-sm">
              {[
                ["AI model", s.llm_model],
                ["Warehouse", s.connection],
                ["Config overrides", String(s.config_overrides)],
                ["Pending invites", String(s.pending_invites)],
                ["Rules to review", String(s.rules_to_review)],
                ["Time zone", s.timezone],
              ].map(([k, v]) => (
                <div key={k}>
                  <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{k}</dt>
                  <dd className="truncate font-medium">{v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className="rounded-2xl bg-surface p-5 shadow-card">
            <h2 className="mb-3 text-sm font-semibold">Latest runs</h2>
            <ul className="space-y-2">
              {ws.runs.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <Link href={`/console/workspaces/${id}/runs/${r.id}`} className="flex items-center justify-between gap-3 rounded-lg bg-card px-3 py-2 text-sm shadow-card hover:shadow-card-hover">
                    <span>{r.type} · {when(r.started_at)}</span>
                    <Pill value={r.status} />
                  </Link>
                </li>
              ))}
              {ws.runs.length === 0 && <li className="text-sm text-muted-foreground">No run yet.</li>}
            </ul>
          </div>
        </section>
      </div>
    );
  } else if (tab === "org") {
    body = <OrgGraph org={ws.org} myRoleIds={[]} />;
  } else if (tab === "runs") {
    const runs = newestFirst(
      ws.runs.filter((r) => (!type || r.type === type) && (!status || r.status === status) && matches(q, r.error, r.period_end)),
      (r) => r.started_at,
    );
    const opts = (vals: string[]) => [...new Set(vals)].map((v) => ({ value: v, label: v, count: vals.filter((x) => x === v).length }));
    body = (
      <div className="space-y-3">
      <ListFilter
        placeholder="Search errors or dates"
        total={ws.runs.length}
        shown={runs.length}
        filters={[
          { param: "type", label: "Type", options: opts(ws.runs.map((r) => r.type)) },
          { param: "status", label: "Status", options: opts(ws.runs.map((r) => r.status)) },
        ]}
      />
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[44rem] overflow-hidden rounded-xl bg-card text-sm shadow-card">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {["Type", "Status", "Started", "Data through", "Warehouse", "AI tokens", ""].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-t border-border/70">
                <td className="px-3 py-2">{r.type}</td>
                <td className="px-3 py-2"><Pill value={r.status} />{r.error && <p className="mt-1 max-w-64 truncate text-[11px] text-muted-foreground" title={r.error}>{r.error}</p>}</td>
                <td className="px-3 py-2 tabular-nums">{when(r.started_at)}</td>
                <td className="px-3 py-2 tabular-nums">{r.period_end}</td>
                <td className="px-3 py-2 tabular-nums">{r.query_seconds.toFixed(2)} s</td>
                <td className="px-3 py-2 tabular-nums">{r.llm_tokens.toLocaleString("en-CA")}</td>
                <td className="px-3 py-2">
                  <Link href={`/console/workspaces/${id}/runs/${r.id}`} className="inline-flex items-center gap-1 text-xs text-brand hover:underline">Inspect <ArrowUpRight className="size-3" /></Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      </div>
    );
  } else if (tab === "cards") {
    const cards = ws.cards.filter((c) => (!role || c.role === role) && matches(q, c.title, c.role, c.signal_kind));
    const roles = [...new Set(ws.cards.map((c) => c.role))].sort();
    body = (
      <div className="space-y-3">
      <ListFilter
        placeholder="Search card titles"
        total={ws.cards.length}
        shown={cards.length}
        filters={[{ param: "role", label: "Role", options: roles.map((r) => ({ value: r, label: r, count: ws.cards.filter((c) => c.role === r).length })) }]}
      />
      <ul className="space-y-2">
        {cards.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-card px-4 py-3 shadow-card">
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{c.title}</p>
              <p className="text-xs text-muted-foreground">{c.role} · {c.signal_kind} · {c.agent ?? "no agent"} · {c.generated_by}</p>
            </div>
            <span className="text-sm font-semibold tabular-nums">{money(c.expected_impact, c.impact_unit)}</span>
          </li>
        ))}
        {cards.length === 0 && <p className="text-sm text-muted-foreground">No open cards{ws.cards.length ? " match" : ""}.</p>}
      </ul>
      </div>
    );
  } else if (tab === "feedback") {
    body = <FeedbackInsightsView data={await consoleApi.feedback(id)} />;
  } else if (tab === "accuracy") {
    body = <AccuracyView workspaceId={id} data={await consoleApi.accuracy(id)} />;
  } else if (tab === "config") {
    const [c, { templates }] = await Promise.all([consoleApi.workspaceConfig(id), consoleApi.measureTemplates(id)]);
    body = (
      <div className="space-y-6">
        <ConfigEditor can={can("config.write")} scope="workspace" workspaceId={id} groups={c.groups} settings={c.settings} roleMetrics={c.role_metrics} metrics={c.metrics} />
        <MeasureManager
          workspaceId={id}
          templates={templates}
          roles={ws.org.roles.map((r) => ({ id: r.id, title: r.title }))}
          watched={c.metrics.filter((m) => m.is_active).map((m) => m.template.split(" ")[0])}
          currency={s.currency}
          can={can("config.write")}
        />
      </div>
    );
  } else if (tab === "ai") {
    body = (
      <div className="max-w-3xl space-y-3">
        <p className="text-sm text-muted-foreground">Which provider and model write this workspace&apos;s cards. Per-agent overrides live in AI agents.</p>
        <LlmForm can={can("llm.write")} initial={(await consoleApi.llm(id)) as LlmSettings} workspaceId={id} />
      </div>
    );
  } else if (tab === "people") {
    const people = ws.people.filter((p) => (!role || p.app_role === role) && matches(q, p.name, p.email));
    body = (
      <div className="space-y-3">
      <ListFilter
        placeholder="Search name or email"
        total={ws.people.length}
        shown={people.length}
        filters={[{ param: "role", label: "Access", options: [...new Set(ws.people.map((p) => p.app_role))].map((r) => ({ value: r, label: r })) }]}
      />
      <ul className="divide-y divide-border/70 overflow-hidden rounded-xl bg-card shadow-card">
        {people.map((p) => (
          <li key={p.id} className={cn("flex flex-wrap items-center gap-3 px-4 py-3 text-sm", !p.active && "opacity-50")}>
            <span className="min-w-0 flex-1"><span className="font-medium">{p.name}</span> <span className="text-muted-foreground">{p.email}</span></span>
            <Pill value={p.active ? p.app_role : "removed"} />
          </li>
        ))}
      </ul>
      </div>
    );
  } else {
    const changes = newestFirst((await consoleApi.history(id)).filter((c) => matches(q, c.key, c.actor)), (c) => c.at);
    const audit = newestFirst(ws.audit.filter((a) => matches(q, a.action, a.actor)), (a) => a.at);
    body = (
      <div className="space-y-3">
      <ListFilter placeholder="Search actions, settings or people" />
      <div className="grid gap-4 lg:grid-cols-2">
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Workspace audit log</h2>
          <ul className="space-y-1.5">
            {audit.map((a, i) => (
              <li key={i} className="rounded-lg bg-card px-3 py-2 text-xs shadow-card">
                <span className="font-medium">{a.action}</span> · {a.actor} · <span className="text-muted-foreground">{when(a.at)}</span>
              </li>
            ))}
          </ul>
        </section>
        <section className="space-y-2">
          <h2 className="text-sm font-semibold">Config changes by the internal team</h2>
          <ul className="space-y-1.5">
            {changes.map((c, i) => (
              <li key={i} className="rounded-lg bg-card px-3 py-2 text-xs break-all shadow-card">
                <span className="font-mono">{c.key}</span>: {JSON.stringify(c.old)} → <span className="font-semibold">{JSON.stringify(c.new)}</span>
                <p className="text-muted-foreground">{c.scope} · {c.actor} · {when(c.at)}</p>
              </li>
            ))}
            {changes.length === 0 && <li className="text-xs text-muted-foreground">No change yet.</li>}
          </ul>
        </section>
      </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <header className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <Link href="/console" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
            <ArrowLeft className="size-3" /> All workspaces
          </Link>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {s.name} <Pill value={s.health} />
          </h1>
          <p className="text-sm text-muted-foreground">
            {s.people} people · {s.roles} roles · {s.locale.toUpperCase()} · {s.timezone} · plan {s.plan}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            href={`/console/workspaces/${id}/onboarding`}
            className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs shadow-card hover:-translate-y-px"
          >
            Onboarding <ArrowUpRight className="size-3" />
          </Link>
          <RunButton workspaceId={id} can={can("runs.trigger")} />
        </div>
      </header>
      <nav className="flex gap-1 overflow-x-auto border-b border-border/70" aria-label="Workspace">
        {TABS.map((t) => (
          <Link
            key={t}
            href={`/console/workspaces/${id}?tab=${t}`}
            aria-current={tab === t ? "page" : undefined}
            className={cn(
              "-mb-px shrink-0 border-b-2 px-3 py-2 text-sm transition-colors",
              tab === t ? "border-brand font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {LABEL[t]}
          </Link>
        ))}
      </nav>
      <div key={tab} className="animate-rise">{body}</div>
    </div>
  );
}
