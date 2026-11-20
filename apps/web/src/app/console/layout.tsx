import { LogOut } from "lucide-react";
import { cookies } from "next/headers";
import Link from "next/link";

import { signOutStaff } from "@/app/console-actions";
import { ConsoleNav, WorkspaceSwitcher } from "@/components/console/console-nav";
import { Logo } from "@/components/logo";
import { Breadcrumb } from "@/components/shell/breadcrumb";
import { MobileNav } from "@/components/shell/mobile-nav";
import { SidebarFrame } from "@/components/shell/sidebar-frame";
import { consoleApi } from "@/lib/console-api";

export const metadata = { title: "Formada · Console" };

const CRUMBS: Record<string, string> = {
  "/console": "Overview",
  "/console/onboarding": "Onboarding",
  "/console/workspaces": "Workspace",
  "/console/config": "Config & rules",
  "/console/agents": "AI agents",
  "/console/ai-lab": "AI lab",
  "/console/rules": "Rule review",
  "/console/team": "Team",
  "/console/account": "Account",
};

export default async function ConsoleLayout({ children }: { children: React.ReactNode }) {
  const [me, overview, jar] = await Promise.all([consoleApi.me(), consoleApi.overview(), cookies()]);
  const collapsed = jar.get("formada.sidebar")?.value === "1";
  const workspaces = overview.workspaces.map((w) => ({ id: w.id, name: w.name, health: w.health }));
  const initials = me.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="sb-logo flex items-center gap-2 px-2.5">
        <Link href="/console" aria-label="Formada console">
          <span className="sb-full inline-flex">
            <Logo />
          </span>
          <span className="sb-mini">
            <Logo withName={false} />
          </span>
        </Link>
      </div>
      <WorkspaceSwitcher workspaces={workspaces} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <ConsoleNav
          rulesToReview={overview.totals.rules_to_review}
          onboardingQuestions={overview.workspaces.reduce((n, w) => n + (w.questions_for_team ?? 0), 0)}
        />
      </div>
      <div className="grid gap-3 pt-6">
        <Link
          href="/console/account"
          title={me.name}
          className="sb-card flex w-full min-w-0 items-center gap-[9px] rounded-[14px] border border-border bg-card p-2 text-left transition-colors hover:bg-surface"
        >
          <span className="grid size-[37px] shrink-0 place-items-center rounded-full bg-soft-violet text-[13px] font-extrabold text-iris-ink">{initials}</span>
          <span className="sb-label min-w-0 flex-1">
            <strong className="block truncate text-[13.5px] font-extrabold">{me.name}</strong>
            <small className="mt-0.5 block truncate text-[11.5px] text-muted-foreground capitalize">{me.staff_role} · internal team</small>
          </span>
        </Link>
        <form action={signOutStaff} className="px-1">
          <button
            type="submit"
            title="Sign out"
            className="sb-row inline-flex min-h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-bold text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
          >
            <LogOut size={15} aria-hidden /> <span className="sb-label">Sign out</span>
          </button>
        </form>
      </div>
    </div>
  );

  return (
    <div className="console bg-background text-foreground">
      <SidebarFrame sidebar={sidebar} defaultCollapsed={collapsed} label="Collapse sidebar">
        <header className="sticky top-0 z-30 flex min-h-[74px] items-center gap-2 border-b border-border bg-card px-[30px] max-md:min-h-[62px] max-md:px-3">
          <MobileNav>{sidebar}</MobileNav>
          <Breadcrumb root="Console" labels={CRUMBS} />
        </header>
        <main className="mx-auto w-full max-w-[90rem] flex-1 px-4 py-6 sm:px-6 sm:py-8 lg:px-10">
          {process.env.LAB_MODE === "true" && (
            <p role="status" className="mb-4 rounded-xl bg-surface px-4 py-2.5 text-xs text-muted-foreground">
              <b className="text-foreground">Review lab.</b> A saved snapshot of a customer&apos;s warehouse, with Claude running live.
              SQL you change is not run on Snowflake here, and there are no weekly runs or cards.
            </p>
          )}
          <div className="page-enter">{children}</div>
        </main>
      </SidebarFrame>
    </div>
  );
}
