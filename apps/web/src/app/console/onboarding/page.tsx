import { Flag, Plus } from "lucide-react";
import Link from "next/link";

import { ListFilter } from "@/components/console/list-filter";
import { STATUS_LABEL, STEP_META } from "@/components/console/onboarding/meta";
import { matches, newestFirst } from "@/lib/list-filter";
import { consoleApi, type TeamStepStatus } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const DOT: Record<TeamStepStatus, string> = {
  done: "bg-foreground",
  client_review: "bg-brand/60",
  working: "bg-brand animate-pulse",
  waiting: "bg-brand/60",
  review: "bg-brand",
  failed: "bg-brand",
  locked: "bg-surface-strong",
  todo: "bg-muted-foreground/40",
};

/** Every workspace still onboarding: where it stands and whose turn it is. */
export default async function OnboardingBoard({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; turn?: string; step?: string }>;
}) {
  const [{ workspaces: all }, { q, turn, step }] = await Promise.all([
    consoleApi.onboardingBoard(),
    searchParams,
  ]);
  const isOurs = (w: (typeof all)[number]) =>
    w.waiting_on === "team" || w.questions_for_team > 0;
  const ours = all.filter(isOurs);
  // Most recent activity first: a message, else when the workspace was created.
  const workspaces = newestFirst(
    all.filter(
      (w) =>
        matches(q, w.name, w.owner) &&
        (!turn || (turn === "ours" ? isOurs(w) : !isOurs(w))) &&
        (!step || w.current === step),
    ),
    (w) => w.last_activity,
    (w) => w.created_at,
  );
  const stepOptions = Object.entries(STEP_META).map(([k, m]) => ({
    value: k,
    label: m.title,
    count: all.filter((w) => w.current === k).length,
  }));
  return (
    <div className="space-y-6">
      <header className="animate-rise flex flex-wrap items-end justify-between gap-4">
        <div className="space-y-1">
          <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">
            Onboarding
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Workspaces being set up
          </h1>
          <p className="text-sm text-muted-foreground">
            {all.length} onboarding · {ours.length} waiting on us. Each
            step needs both sides&apos; approval before the next opens.
          </p>
        </div>
        <Link
          href="/console/onboarding/new"
          className="inline-flex items-center gap-1.5 rounded-full bg-foreground px-3 py-1.5 text-xs text-background shadow-card hover:-translate-y-px"
        >
          <Plus className="size-3.5" /> New workspace
        </Link>
      </header>

      <ListFilter
        placeholder="Search by workspace or owner"
        total={all.length}
        shown={workspaces.length}
        filters={[
          {
            param: "turn",
            label: "Whose turn",
            options: [
              { value: "ours", label: "Our turn", count: ours.length },
              { value: "client", label: "Client's turn", count: all.length - ours.length },
            ],
          },
          { param: "step", label: "Step", options: stepOptions },
        ]}
      />

      {workspaces.length === 0 ? (
        <p className="rounded-xl bg-surface py-12 text-center text-sm text-muted-foreground">
          {all.length
            ? "No workspace matches these filters."
            : "No workspace is onboarding. Start one with New workspace."}
        </p>
      ) : (
        <ul className="space-y-3">
          {workspaces.map((w, i) => (
            <li
              key={w.id}
              className="animate-rise"
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              <Link
                href={`/console/workspaces/${w.id}/onboarding`}
                className="group block rounded-2xl bg-card p-4 shadow-card transition-all hover:-translate-y-0.5 hover:shadow-card-hover"
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium group-hover:underline">
                      {w.name}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {w.owner ?? "No owner"} · started{" "}
                      {new Date(w.created_at).toLocaleDateString("en-CA")}
                      {w.last_activity &&
                        ` · last message ${new Date(w.last_activity).toLocaleDateString("en-CA")}`}
                    </p>
                  </div>
                  <div className="text-right text-sm">
                    <p className="font-medium">{STEP_META[w.current].title}</p>
                    <p
                      className={cn(
                        "text-xs",
                        w.waiting_on === "team"
                          ? "font-medium text-brand"
                          : "text-muted-foreground",
                      )}
                    >
                      {STATUS_LABEL[w.status]} ·{" "}
                      {w.waiting_on === "team" ? "our turn" : "client's turn"}
                    </p>
                  </div>
                  {w.questions_for_team > 0 && (
                    <span className="flag-pulse inline-flex items-center gap-1 rounded-full bg-brand px-2 py-0.5 text-[11px] font-semibold text-brand-foreground">
                      <Flag className="size-3" /> {w.questions_for_team}
                    </span>
                  )}
                </div>
                <div className="mt-3 flex items-center gap-1.5">
                  {w.steps.map((s) => (
                    <span
                      key={s.key}
                      title={`${STEP_META[s.key].title}: ${STATUS_LABEL[s.status]}`}
                      className="flex-1"
                    >
                      <span
                        className={cn(
                          "block h-1.5 rounded-full",
                          DOT[s.status],
                        )}
                      />
                    </span>
                  ))}
                  <span className="ml-2 w-10 text-right text-xs tabular-nums text-muted-foreground">
                    {w.percent}%
                  </span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
