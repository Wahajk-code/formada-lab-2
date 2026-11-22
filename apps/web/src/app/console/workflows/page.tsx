import { Workflow } from "lucide-react";

import { FlowBoard } from "@/components/console/workflows/flow-board";
import { consoleApi } from "@/lib/console-api";

/** Every workflow the in-app scheduler runs (ADR 0034), drawn from the data it runs, with a pause
 * switch and Run now. Internal team only. */
export default async function WorkflowsPage() {
  const [data, overview, me] = await Promise.all([consoleApi.flows(), consoleApi.overview(), consoleApi.me()]);
  const workspaces = [...overview.workspaces].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ id: w.id, name: w.name }));
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Workflow className="size-6" aria-hidden /> Workflows
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          What the app runs on its own, and when. Each picture is the real flow: the steps in the order they run, and the tables each step reads and writes. Pause a flow, or run
          it now for a workspace. To change a flow, change it in code (docs/scheduler.md).
        </p>
      </header>
      <FlowBoard data={data} workspaces={workspaces} can={me.permissions.includes("runs.trigger")} />
    </div>
  );
}
