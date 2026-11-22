import { Workflow } from "lucide-react";

import { FlowBoard } from "@/components/console/workflows/flow-board";
import { consoleApi, type FlowBoardData, type RunState } from "@/lib/console-api";

/** Every workflow the in-app scheduler runs (ADR 0034), as a flow chart, and a live view of any
 * workspace's run on it. The flow and the workspace are in the address, so a view can be shared.
 * Internal team only. */
export default async function WorkflowsPage({ searchParams }: { searchParams: Promise<{ flow?: string; ws?: string }> }) {
  const [{ flow: flowParam, ws }, data, overview, me] = await Promise.all([searchParams, consoleApi.flows(), consoleApi.overview(), consoleApi.me()]);
  const flow = data.flows.find((f) => f.key === flowParam) ?? data.flows[0];
  const workspaces = [...overview.workspaces].sort((a, b) => a.name.localeCompare(b.name)).map((w) => ({ id: w.id, name: w.name }));

  // For a flow that records runs: every workspace's latest run, and the chosen one drawn on the chart.
  let board: FlowBoardData | null = null;
  let live: RunState | null = null;
  if (flow?.run_type) {
    board = await consoleApi.flowBoard(flow.key).catch(() => null);
    const row = board?.workspaces.find((w) => w.workspace.id === ws);
    if (row?.run) live = await consoleApi.flowRunState(row.workspace.id, row.run.id).catch(() => null);
  }

  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Workflow className="size-6" aria-hidden /> Workflows
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          What the app runs on its own. Pick a workflow to see its steps and what happens when one goes wrong, then pick a workspace to watch its run on the chart.
        </p>
      </header>
      <FlowBoard data={data} flowKey={flow?.key ?? ""} board={board} live={live} selectedWs={live ? (ws ?? null) : null} workspaces={workspaces} can={me.permissions.includes("runs.trigger")} />
    </div>
  );
}
