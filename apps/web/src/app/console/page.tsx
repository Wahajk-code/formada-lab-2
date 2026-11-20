import { AlertTriangle, Bot, Building2, Coins, Layers, Plus, Scale, Users } from "lucide-react";
import Link from "next/link";

import { Stat } from "@/components/charts/stat";
import { WorkspaceBoard } from "@/components/console/workspace-board";
import { consoleApi } from "@/lib/console-api";

const money = (v: number) =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", notation: "compact", maximumFractionDigits: 1 }).format(v);

export default async function ConsoleOverview() {
  const { totals, workspaces } = await consoleApi.overview();
  return (
    <div className="space-y-6">
      <header className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
          <h1 className="text-2xl font-semibold tracking-tight">All workspaces</h1>
          <p className="max-w-3xl text-sm text-muted-foreground">
            One row per client. Search, filter and sort; open a workspace for its org web, runs, cards, config and AI model.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/console/rules" className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs shadow-card hover:-translate-y-px">
            <Scale className="size-3.5" /> {totals.rules_to_review} rules to review
          </Link>
          <Link href="/console/agents" className="inline-flex items-center gap-1.5 rounded-full bg-card px-3 py-1.5 text-xs shadow-card hover:-translate-y-px">
            <Bot className="size-3.5" /> AI agents
          </Link>
          <Link href="/console/onboarding/new" className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs text-background shadow-card hover:-translate-y-px">
            <Plus className="size-3.5" /> New workspace
          </Link>
        </div>
      </header>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat label="Workspaces" value={String(totals.workspaces)} hint={`${totals.attention} need attention`} icon={<Building2 className="size-3.5" />} />
        <Stat label="People" value={String(totals.people)} hint="Active seats across clients" icon={<Users className="size-3.5" />} delay={60} />
        <Stat
          label="Open cards"
          value={String(totals.open_cards)}
          hint={`${money(totals.impact_at_stake)} impact at stake · ${money(totals.value_captured)} captured`}
          icon={<Layers className="size-3.5" />}
          delay={120}
        />
        <Stat
          label="AI this month"
          value={`US$${totals.llm_cost_month_usd.toFixed(3)}`}
          hint={`${totals.llm_tokens_month.toLocaleString("en-CA")} tokens`}
          icon={<Coins className="size-3.5" />}
          delay={180}
        />
      </div>

      {totals.attention > 0 && (
        <p className="animate-rise flex items-center gap-2 rounded-xl bg-brand/10 px-4 py-3 text-sm text-brand">
          <AlertTriangle className="size-4" aria-hidden />
          {totals.attention} workspace{totals.attention > 1 ? "s need" : " needs"} attention: failed runs, credit use, a high Not relevant rate or rules waiting for review.
        </p>
      )}

      <WorkspaceBoard workspaces={workspaces} />
    </div>
  );
}
