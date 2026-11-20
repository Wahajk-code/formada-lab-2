import { TeamManager } from "@/components/console/team-manager";
import { consoleApi } from "@/lib/console-api";

const MATRIX: [string, string, boolean, boolean][] = [
  ["See every workspace, run, prompt and card", "view", true, true],
  ["Preview config changes on last week's data", "config.preview", true, true],
  ["Draft agent prompt versions", "agent.draft", true, true],
  ["Evaluate an agent version (spends tokens)", "agent.evaluate", true, true],
  ["Change business rules, thresholds, money values", "config.write", true, false],
  ["Change a workspace's AI model", "llm.write", true, false],
  ["Make a prompt version live, set agent models", "agent.activate", true, false],
  ["Accept or reject proposed rules", "rules.review", true, false],
  ["Start a run for a client", "runs.trigger", true, false],
  ["Add team members, change roles", "staff.manage", true, false],
];

export default async function TeamPage() {
  const [me, staff] = await Promise.all([consoleApi.me(), consoleApi.staff()]);
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="text-2xl font-semibold tracking-tight">Team</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Admins change what clients see and pay for. Developers can see and test everything but cannot change anything live.
        </p>
      </header>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_26rem]">
        <TeamManager staff={staff} meEmail={me.email} canManage={me.permissions.includes("staff.manage")} />
        <section className="space-y-2 xl:self-start">
          <h2 className="text-sm font-semibold">Who can do what</h2>
          <table className="w-full overflow-hidden rounded-xl bg-card text-xs shadow-card">
            <thead>
              <tr className="text-left text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                <th className="px-3 py-2 font-medium">Action</th>
                <th className="px-2 py-2 text-center font-medium">Admin</th>
                <th className="px-2 py-2 text-center font-medium">Developer</th>
              </tr>
            </thead>
            <tbody>
              {MATRIX.map(([label, key, admin, dev]) => (
                <tr key={key} className="border-t border-border/70">
                  <td className="px-3 py-2">{label}<p className="font-mono text-[10px] text-muted-foreground">{key}</p></td>
                  <td className="px-2 py-2 text-center">{admin ? "✓" : "–"}</td>
                  <td className="px-2 py-2 text-center">{dev ? "✓" : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </div>
  );
}
