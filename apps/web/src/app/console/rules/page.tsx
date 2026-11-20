import Link from "next/link";

import { ConsoleRuleCard } from "@/components/console/console-rules";
import { ListFilter } from "@/components/console/list-filter";
import { consoleApi } from "@/lib/console-api";
import { matches, newestFirst } from "@/lib/list-filter";
import { cn } from "@/lib/utils";

const FILTERS = ["proposed", "active", "retired", "rejected"] as const;

/** Feedback rules belong to one workspace each, so they are reviewed workspace by workspace.
 * System-wide numbers live in Config & rules, not here. */
export default async function ConsoleRulesPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; workspace?: string; q?: string; type?: string }>;
}) {
  const { status: raw, workspace, q, type } = await searchParams;
  const status = FILTERS.includes(raw as (typeof FILTERS)[number]) ? raw : "proposed";
  const [all, me] = await Promise.all([consoleApi.rules(), consoleApi.me()]);
  const counts = Object.fromEntries(FILTERS.map((f) => [f, all.filter((r) => r.status === f).length]));
  const inStatus = all.filter((r) => r.status === status);
  const rules = newestFirst(
    inStatus.filter(
      (r) =>
        (!workspace || r.workspace_id === workspace) &&
        (!type || r.rule_type === type) &&
        matches(q, r.text, r.suggested_text, r.role, r.metric, r.workspace),
    ),
    (r) => r.created_at,
  );
  const workspaces = [...new Map(all.map((r) => [r.workspace_id, r.workspace])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
  // One section per workspace, the busiest first.
  const groups = workspaces
    .map(([id, name]) => ({ id, name, rules: rules.filter((r) => r.workspace_id === id) }))
    .filter((g) => g.rules.length)
    .sort((a, b) => b.rules.length - a.rules.length);
  const keep = (extra: string) =>
    [workspace && `workspace=${workspace}`, q && `q=${encodeURIComponent(q)}`, type && `type=${type}`, extra].filter(Boolean).join("&");

  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="text-2xl font-semibold tracking-tight">Rule review</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Repeated feedback in a workspace proposes a rule for that workspace only (hide or down-rank a kind of card for a
          role). Nothing changes until someone here, or the workspace&apos;s own admin, accepts it. System-wide numbers are in{" "}
          <Link href="/console/config" className="underline underline-offset-2">Config &amp; rules</Link>.
        </p>
      </header>
      <nav className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <Link
            key={f}
            href={`/console/rules?${keep(`status=${f}`)}`}
            className={cn("rounded-full px-3 py-1.5 text-xs capitalize", status === f ? "bg-brand text-brand-foreground" : "bg-surface text-muted-foreground hover:text-foreground")}
          >
            {f} <span className="opacity-70">{counts[f]}</span>
          </Link>
        ))}
      </nav>
      <ListFilter
        placeholder="Search rule text, role or measure"
        total={inStatus.length}
        shown={rules.length}
        filters={[
          {
            param: "workspace",
            label: "Workspace",
            options: workspaces.map(([id, name]) => ({ value: id, label: name, count: inStatus.filter((r) => r.workspace_id === id).length })),
          },
          {
            param: "type",
            label: "Kind",
            options: [
              { value: "downweight", label: "Down-rank" },
              { value: "forbid", label: "Hide" },
            ],
          },
        ]}
      />
      {groups.map((g) => (
        <section key={g.id} className="space-y-3">
          <div className="flex items-baseline gap-3">
            <h2 className="text-sm font-semibold">{g.name}</h2>
            <span className="text-xs text-muted-foreground">
              {g.rules.length} {status}
            </span>
            <Link href={`/console/workspaces/${g.id}?tab=feedback`} className="ml-auto text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground">
              Feedback in this workspace
            </Link>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {g.rules.map((r) => <ConsoleRuleCard key={r.id} rule={r} can={me.permissions.includes("rules.review")} />)}
          </div>
        </section>
      ))}
      {rules.length === 0 && <p className="rounded-xl bg-surface py-12 text-center text-sm text-muted-foreground">Nothing here.</p>}
    </div>
  );
}
