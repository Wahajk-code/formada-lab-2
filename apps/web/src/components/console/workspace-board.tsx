"use client";

import { ArrowUpRight, Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { WorkspaceSummary } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const money = (v: number, currency = "CAD") =>
  new Intl.NumberFormat("en-CA", { style: "currency", currency, notation: "compact", maximumFractionDigits: 1 }).format(v);
const pct = (v: number | null) => (v === null ? "–" : `${Math.round(v * 100)}%`);

const SORTS = {
  // Most recent activity first: the last run, else when the workspace was created.
  recent: (a: WorkspaceSummary, b: WorkspaceSummary) =>
    (b.last_run?.started_at ?? b.created_at).localeCompare(a.last_run?.started_at ?? a.created_at),
  attention: (a: WorkspaceSummary, b: WorkspaceSummary) =>
    Number(b.health === "attention") - Number(a.health === "attention") || a.name.localeCompare(b.name),
  name: (a: WorkspaceSummary, b: WorkspaceSummary) => a.name.localeCompare(b.name),
  impact: (a: WorkspaceSummary, b: WorkspaceSummary) => b.impact_at_stake - a.impact_at_stake,
  cost: (a: WorkspaceSummary, b: WorkspaceSummary) => (b.llm_cost_month_usd ?? 0) - (a.llm_cost_month_usd ?? 0),
  notRelevant: (a: WorkspaceSummary, b: WorkspaceSummary) => (b.not_relevant_rate ?? -1) - (a.not_relevant_rate ?? -1),
};

/** Every workspace on one board: search by name, filter by health or locale, sort. */
export function WorkspaceBoard({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const [q, setQ] = useState("");
  const [health, setHealth] = useState<"all" | "attention" | "healthy">("all");
  const [locale, setLocale] = useState<"all" | "en" | "fr">("all");
  const [sort, setSort] = useState<keyof typeof SORTS>("recent");
  const shown = useMemo(
    () =>
      workspaces
        .filter((w) => w.name.toLowerCase().includes(q.toLowerCase()))
        .filter((w) => health === "all" || w.health === health)
        .filter((w) => locale === "all" || w.locale === locale)
        .sort(SORTS[sort]),
    [workspaces, q, health, locale, sort],
  );

  return (
    <section className="animate-rise space-y-4 rounded-2xl bg-surface p-4 shadow-card sm:p-5" style={{ animationDelay: "120ms" }}>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search workspaces"
            aria-label="Search workspaces"
            className="w-full rounded-lg border border-input bg-card py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-ring/30"
          />
        </label>
        <div className="flex rounded-lg bg-card p-0.5 text-xs shadow-card" role="group" aria-label="Health">
          {(["all", "attention", "healthy"] as const).map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHealth(h)}
              aria-pressed={health === h}
              className={cn("rounded-md px-2.5 py-1.5 capitalize transition-colors", health === h ? "bg-brand text-brand-foreground" : "text-muted-foreground hover:text-foreground")}
            >
              {h === "attention" ? "Needs attention" : h}
            </button>
          ))}
        </div>
        <select value={locale} onChange={(e) => setLocale(e.target.value as typeof locale)} aria-label="Language" className="rounded-lg border border-input bg-card px-2.5 py-2 text-xs">
          <option value="all">All languages</option>
          <option value="en">English</option>
          <option value="fr">French</option>
        </select>
        <select value={sort} onChange={(e) => setSort(e.target.value as keyof typeof SORTS)} aria-label="Sort" className="rounded-lg border border-input bg-card px-2.5 py-2 text-xs">
          <option value="recent">Most recent first</option>
          <option value="attention">Needs attention first</option>
          <option value="name">Name</option>
          <option value="impact">Impact at stake</option>
          <option value="cost">AI cost this month</option>
          <option value="notRelevant">Not relevant rate</option>
        </select>
      </div>

      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="text-left text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {["Workspace", "Last run", "Open cards", "Impact", "Value", "Actioned", "Not relevant", "Credits", "AI this month", ""].map((h) => (
                <th key={h} className="px-2 pb-2 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((w) => (
              <tr key={w.id} className="group border-t border-border/70 align-top transition-colors hover:bg-card">
                <td className="px-2 py-3">
                  <Link href={`/console/workspaces/${w.id}`} className="font-medium hover:underline">{w.name}</Link>
                  {w.lifecycle === "onboarding" && (
                    <Link
                      href={`/console/workspaces/${w.id}/onboarding`}
                      className="ml-2 inline-flex items-center gap-1 rounded-full bg-soft-violet px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-iris"
                    >
                      Onboarding
                      {w.questions_for_team > 0 && <span className="flag-pulse rounded-full bg-brand px-1 text-brand-foreground">{w.questions_for_team}</span>}
                    </Link>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {w.people} people · {w.roles} roles · {w.locale.toUpperCase()} · {w.plan}
                  </p>
                  {w.attention.length > 0 && (
                    <p className="mt-1 flex flex-wrap gap-1">
                      {w.attention.map((a) => (
                        <span key={a} className="rounded-full bg-brand/10 px-2 py-0.5 text-[11px] font-medium text-brand">{a}</span>
                      ))}
                    </p>
                  )}
                </td>
                <td className="px-2 py-3 text-xs">
                  {w.last_run ? (
                    <>
                      <span className={cn("rounded-full px-2 py-0.5 font-medium", w.last_run.status === "succeeded" ? "bg-surface-strong" : "bg-brand text-brand-foreground")}>
                        {w.last_run.status}
                      </span>
                      <p className="mt-1 text-muted-foreground">{w.last_run.type} · {w.last_run.started_at.slice(0, 10)}</p>
                    </>
                  ) : (
                    <span className="text-muted-foreground">never</span>
                  )}
                </td>
                <td className="px-2 py-3 tabular-nums">{w.open_cards}</td>
                <td className="px-2 py-3 tabular-nums">{money(w.impact_at_stake, w.currency)}</td>
                <td className="px-2 py-3 tabular-nums">{money(w.value_captured, w.currency)}</td>
                <td className="px-2 py-3 tabular-nums">{pct(w.actioned_rate)}</td>
                <td className={cn("px-2 py-3 tabular-nums", (w.not_relevant_rate ?? 0) > 0.2 && "font-semibold text-brand")}>{pct(w.not_relevant_rate)}</td>
                <td className="px-2 py-3 text-xs tabular-nums">
                  {w.credits_month.toFixed(3)}
                  {w.credit_cap ? <span className="text-muted-foreground"> / {w.credit_cap}</span> : null}
                </td>
                <td className="px-2 py-3 text-xs tabular-nums">
                  {w.llm_tokens_month.toLocaleString("en-CA")} tok
                  <p className="text-muted-foreground">{w.llm_cost_month_usd !== null ? `US$${w.llm_cost_month_usd.toFixed(4)}` : "–"}</p>
                </td>
                <td className="px-2 py-3">
                  <Link href={`/console/workspaces/${w.id}`} aria-label={`Open ${w.name}`} className="inline-flex rounded-lg p-1.5 text-muted-foreground opacity-0 transition-opacity hover:bg-surface hover:text-foreground group-hover:opacity-100">
                    <ArrowUpRight className="size-4" />
                  </Link>
                </td>
              </tr>
            ))}
            {shown.length === 0 && (
              <tr>
                <td colSpan={10} className="px-2 py-10 text-center text-muted-foreground">No workspace matches these filters.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}
