import { ConfigEditor } from "@/components/console/config-editor";
import { ListFilter } from "@/components/console/list-filter";
import { matches, newestFirst } from "@/lib/list-filter";
import { consoleApi } from "@/lib/console-api";

const when = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Toronto" }).format(new Date(iso));

export default async function SystemConfigPage({ searchParams }: { searchParams: Promise<{ q?: string; scope?: string }> }) {
  const [cfg, history, me, { q, scope }] = await Promise.all([consoleApi.systemConfig(), consoleApi.history(), consoleApi.me(), searchParams]);
  const where = (c: (typeof history)[number]) => c.workspace ?? "system";
  const changes = newestFirst(
    history.filter((c) => matches(q, c.key, c.workspace, c.actor) && (!scope || where(c) === scope)),
    (c) => c.at,
  );
  const scopes = [...new Set(history.map(where))].sort((a, b) => (a === "system" ? -1 : b === "system" ? 1 : a.localeCompare(b)));
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="text-2xl font-semibold tracking-tight">Config and business rules</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Every number the detection, ranking, feedback and run rules use. Layers, last wins: code default → system (here, all
          workspaces) → workspace (open a workspace › Config & rules). Each value has a safe range; every change is recorded.
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <ConfigEditor scope="system" groups={cfg.groups} settings={cfg.settings} can={me.permissions.includes("config.write")} />
        <aside className="space-y-2 xl:sticky xl:top-6 xl:self-start">
          <h2 className="text-sm font-semibold">Recent changes</h2>
          <ListFilter
            placeholder="Search setting or person"
            filters={[{ param: "scope", label: "Where", options: scopes.map((x) => ({ value: x, label: x === "system" ? "System (all workspaces)" : x, count: history.filter((c) => where(c) === x).length })) }]}
          />
          <ul className="max-h-[70vh] space-y-1.5 overflow-y-auto pr-1">
            {changes.map((c, i) => (
              <li key={i} className="rounded-lg bg-card px-3 py-2 text-xs break-all shadow-card">
                <span className="font-mono">{c.key}</span>: {JSON.stringify(c.old)} → <span className="font-semibold">{JSON.stringify(c.new)}</span>
                <p className="text-muted-foreground">
                  {c.workspace ?? "system"} · {c.scope} · {c.actor.replace("staff:", "")} · {when(c.at)}
                </p>
              </li>
            ))}
            {changes.length === 0 && <li className="text-xs text-muted-foreground">No change yet.</li>}
          </ul>
        </aside>
      </div>
    </div>
  );
}
