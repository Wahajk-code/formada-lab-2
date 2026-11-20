import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { AgentEditor } from "@/components/console/agent-editor";
import { ApiError } from "@/lib/client-api";
import { consoleApi } from "@/lib/console-api";

export default async function AgentPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const [agent, overview, me] = await Promise.all([
    consoleApi.agent(key).catch((e) => {
      if (e instanceof ApiError && e.status === 404) notFound();
      throw e;
    }),
    consoleApi.overview(),
    consoleApi.me(),
  ]);
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <Link href="/console/agents" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3" /> AI agents
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{agent.name}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{agent.description}</p>
        <p className="font-mono text-[11px] text-muted-foreground">
          {agent.key} · {agent.kind}
          {agent.playbook ? ` · ${agent.playbook} playbook` : ""} · live v{agent.active_version}
        </p>
      </header>
      <AgentEditor can={me.permissions.includes("agent.activate")} agent={agent} workspaces={[...overview.workspaces].sort((a, b) => b.llm_tokens_month - a.llm_tokens_month).map((w) => ({ id: w.id, name: w.name }))} />
    </div>
  );
}
