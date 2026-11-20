import { ArrowUpRight, Bot, FileText, Languages, Sparkles, Workflow } from "lucide-react";
import Link from "next/link";

import { ListFilter } from "@/components/console/list-filter";
import { type AgentSummary, consoleApi } from "@/lib/console-api";
import { matches } from "@/lib/list-filter";

const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

/** Every kind of agent we run, in the order a client meets them. Unknown kinds still render. */
const KINDS: { kind: string; title: string; what: string; icon: typeof Bot }[] = [
  { kind: "onboarding", title: "Onboarding", what: "Read a new client’s data and propose each setup step. Our team approves every proposal.", icon: Workflow },
  { kind: "card_writer", title: "Card writers", what: "Turn the problems code found into short cards, one playbook per department. Every number is checked.", icon: FileText },
  { kind: "translator", title: "Translation", what: "Translate cards between English and French on request.", icon: Languages },
  { kind: "rule_drafter", title: "Feedback rules", what: "Word the rules that repeated feedback proposes, for review.", icon: Bot },
  { kind: "console", title: "Console help", what: "Suggest settings, measures and new agent instructions for our team. It only suggests; a person saves.", icon: Sparkles },
];

export default async function AgentsPage({ searchParams }: { searchParams: Promise<{ q?: string; kind?: string }> }) {
  const [{ agents }, { q, kind }] = await Promise.all([consoleApi.agents(), searchParams]);
  const shown = agents.filter((a) => matches(q, a.name, a.key, a.description, a.playbook) && (!kind || a.kind === kind));
  const known = new Set(KINDS.map((k) => k.kind));
  const groups = [
    ...KINDS,
    ...[...new Set(agents.map((a) => a.kind))].filter((k) => !known.has(k)).map((k) => ({ kind: k, title: k.replaceAll("_", " "), what: "", icon: Sparkles })),
  ];

  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="text-2xl font-semibold tracking-tight">AI agents</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Each agent does one job with a versioned prompt. Code finds every number and checks every output; the agents only
          propose and write. Open one to read or edit its instructions, try a new version, or switch its model.
        </p>
      </header>
      <ListFilter
        placeholder="Search agents"
        total={agents.length}
        shown={shown.length}
        filters={[{ param: "kind", label: "Job", options: groups.map((g) => ({ value: g.kind, label: g.title, count: agents.filter((a) => a.kind === g.kind).length })) }]}
      />
      {groups.map((g) => {
        const list = shown.filter((a) => a.kind === g.kind);
        if (!list.length) return null;
        return (
          <section key={g.kind} className="space-y-3">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-sm font-semibold">{g.title}</h2>
              <p className="text-xs text-muted-foreground">{g.what}</p>
            </div>
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {list.map((a, i) => (
                <AgentCard key={a.key} a={a} Icon={g.icon} delay={i * 50} />
              ))}
            </div>
          </section>
        );
      })}
      {shown.length === 0 && <p className="rounded-xl bg-surface py-12 text-center text-sm text-muted-foreground">No agent matches.</p>}
    </div>
  );
}

function AgentCard({ a, Icon, delay }: { a: AgentSummary; Icon: typeof Bot; delay: number }) {
  const writer = a.kind === "card_writer";
  return (
    <Link
      href={`/console/agents/${a.key}`}
      className="animate-rise group flex flex-col gap-4 rounded-2xl bg-card p-5 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-brand/10 text-brand">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{a.name}</p>
          <p className="font-mono text-[11px] text-muted-foreground">
            {a.key} · v{a.active_version} of {a.versions}
          </p>
        </div>
        <ArrowUpRight className="size-4 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
      </div>
      <p className="text-sm text-muted-foreground">{a.description}</p>
      <dl className="mt-auto grid grid-cols-3 gap-2 text-center">
        {(writer
          ? [
              ["Cards", String(a.stats.cards)],
              ["Actioned", pct(a.stats.action_rate)],
              ["Rejected", pct(a.stats.rejection_rate)],
            ]
          : [
              ["Calls", String(a.stats.calls)],
              ["Tokens", a.stats.tokens.toLocaleString("en-CA")],
              ["Model", a.model_override ? "own" : "workspace"],
            ]
        ).map(([k, v]) => (
          <div key={k} className="rounded-lg bg-surface px-2 py-1.5">
            <dt className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{k}</dt>
            <dd className="text-sm font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
      <p className="flex flex-wrap gap-1.5 text-[11px]">
        {a.playbook && <span className="rounded-full bg-surface px-2 py-0.5">{a.playbook}</span>}
        {writer && <span className="rounded-full bg-surface px-2 py-0.5">{a.use_examples ? "learns from feedback" : "no examples"}</span>}
        {a.model_override && <span className="rounded-full bg-brand/10 px-2 py-0.5 text-brand">{a.model_override}</span>}
      </p>
    </Link>
  );
}
