import Link from "next/link";

import { WelcomeButton } from "@/components/console/onboarding/welcome-button";
import { Icon } from "@/components/ui/icon";
import { consoleApi } from "@/lib/console-api";

/** The Formada view of one workspace's onboarding (design + ADR 0030). */
export default async function OnboardingLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [state, me] = await Promise.all([consoleApi.onboarding(id), consoleApi.me()]);
  const spent = Object.values(state.steps).reduce((sum, s) => sum + (s?.cost_usd ?? 0), 0);
  return (
    <div className="onboarding">
      <div className="onboarding-heading flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={`/console/workspaces/${id}`} className="mb-2 inline-flex items-center gap-1 text-xs font-bold text-iris hover:text-iris-ink">
            <Icon name="arrow-left" size={14} /> {state.workspace.name}
          </Link>
          <h1>Workspace onboarding</h1>
          <p>
            Manage the connection, discovery and mapping, and follow the customer’s setup.{" "}
            <span className="tag">AI US${spent.toFixed(3)}</span>
          </p>
        </div>
        {state.workspace.owner && state.progress.current === "connect" && (
          <WelcomeButton workspaceId={id} owner={state.workspace.owner.email} can={me.permissions.includes("config.write")} />
        )}
      </div>
      {children}
    </div>
  );
}
