"use client";

import { Check, CircleDot, Flag, Lock, LoaderCircle, X } from "lucide-react";
import Link from "next/link";
import { useSelectedLayoutSegment } from "next/navigation";

import { cn } from "@/lib/utils";

export type StepStatus =
  | "done"
  | "working"
  | "waiting"
  | "review"
  | "failed"
  | "locked"
  | "todo"
  | "needs_you"
  | "in_progress"
  | "upcoming"
  | "client_review"
  | "your_review"
  | "your_input";

/** Statuses that ask something of whoever is looking at the stepper. */
const ATTENTION: StepStatus[] = [
  "waiting",
  "needs_you",
  "failed",
  "your_review",
  "your_input",
];

export type StepItem = {
  key: string;
  label: string;
  status: StepStatus;
  statusLabel: string;
  href: string;
  /** Open questions waiting for whoever is looking at this stepper. */
  flags?: number;
  /** Shown in the bar but not openable (sequential onboarding: future steps). */
  disabled?: boolean;
};

function Dot({
  status,
  index,
  active,
}: {
  status: StepStatus;
  index: number;
  active: boolean;
}) {
  const icon =
    status === "done" ? (
      <Check className="size-4" strokeWidth={2.5} />
    ) : status === "working" ? (
      <LoaderCircle className="size-4 animate-spin" />
    ) : status === "locked" || status === "upcoming" ? (
      <Lock className="size-3.5" />
    ) : status === "failed" ? (
      <X className="size-4" />
    ) : status === "review" ||
      status === "in_progress" ||
      status === "client_review" ||
      status === "your_review" ||
      status === "your_input" ? (
      <CircleDot className="size-4" />
    ) : (
      <span className="text-xs font-semibold tabular-nums">{index + 1}</span>
    );
  return (
    <span
      className={cn(
        "relative grid size-9 shrink-0 place-items-center rounded-full transition-all duration-300",
        status === "done" && "bg-foreground text-background",
        status !== "done" && "bg-card text-foreground shadow-card",
        (status === "locked" || status === "upcoming") &&
          "text-muted-foreground",
        active && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
      )}
    >
      {icon}
    </span>
  );
}

/** Progress bar plus clickable steps. Moving to a later step slides forward, earlier slides back. */
export function Stepper({
  items,
  current: currentProp,
  percent,
  label,
}: {
  items: StepItem[];
  /** Defaults to the active child route segment, so a layout can render the stepper. */
  current?: string;
  percent: number;
  label: string;
}) {
  const segment = useSelectedLayoutSegment();
  const current = currentProp ?? segment ?? items[0]?.key;
  const at = Math.max(
    0,
    items.findIndex((i) => i.key === current),
  );
  return (
    <nav
      aria-label={label}
      className="space-y-4"
      style={{ viewTransitionName: "onboarding-stepper" }}
    >
      <div className="flex items-center gap-3">
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-strong"
          role="progressbar"
          aria-valuenow={percent}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={label}
        >
          <div
            className="h-full rounded-full bg-foreground transition-[width] duration-700 ease-out"
            style={{ width: `${percent}%` }}
          />
        </div>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {percent}%
        </span>
      </div>
      <ol className="-mx-1 flex snap-x gap-1 overflow-x-auto px-1 pb-1">
        {items.map((item, i) => {
          const active = item.key === current;
          return (
            <li
              key={item.key}
              className="flex min-w-[8.5rem] flex-1 snap-start items-center"
            >
              {item.disabled ? (
                <div
                  aria-disabled
                  title={item.statusLabel}
                  className="flex w-full cursor-not-allowed items-center gap-2.5 rounded-xl px-2 py-2 opacity-55"
                >
                  <span className="relative">
                    <Dot status={item.status} index={i} active={active} />
                    {!!item.flags && (
                      <span
                        className="flag-pulse absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-brand text-[9px] font-bold text-brand-foreground"
                        title={`${item.flags} open`}
                      >
                        {item.flags}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span
                      className={cn(
                        "block truncate text-sm",
                        active ? "font-semibold" : "font-medium",
                      )}
                    >
                      {item.label}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1 truncate text-[11px]",
                        ATTENTION.includes(item.status)
                          ? "font-medium text-brand"
                          : "text-muted-foreground",
                      )}
                    >
                      {ATTENTION.includes(item.status) &&
                        item.status !== "failed" && <Flag className="size-3" />}
                      {item.statusLabel}
                    </span>
                  </span>
                </div>
              ) : (
                <Link
                  href={item.href}
                  transitionTypes={[
                    i > at ? "step-forward" : i < at ? "step-back" : "none",
                  ]}
                  aria-current={active ? "step" : undefined}
                  className={cn(
                    "group flex w-full items-center gap-2.5 rounded-xl px-2 py-2 transition-colors",
                    active ? "bg-surface" : "hover:bg-surface/70",
                  )}
                >
                  <span className="relative">
                    <Dot status={item.status} index={i} active={active} />
                    {!!item.flags && (
                      <span
                        className="flag-pulse absolute -right-1 -top-1 grid size-4 place-items-center rounded-full bg-brand text-[9px] font-bold text-brand-foreground"
                        title={`${item.flags} open`}
                      >
                        {item.flags}
                      </span>
                    )}
                  </span>
                  <span className="min-w-0 leading-tight">
                    <span
                      className={cn(
                        "block truncate text-sm",
                        active ? "font-semibold" : "font-medium",
                      )}
                    >
                      {item.label}
                    </span>
                    <span
                      className={cn(
                        "flex items-center gap-1 truncate text-[11px]",
                        ATTENTION.includes(item.status)
                          ? "font-medium text-brand"
                          : "text-muted-foreground",
                      )}
                    >
                      {ATTENTION.includes(item.status) &&
                        item.status !== "failed" && <Flag className="size-3" />}
                      {item.statusLabel}
                    </span>
                  </span>
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

/** Previous / next links under a step, with the matching slide direction. */
export function StepNav({
  prev,
  next,
  labels,
}: {
  prev?: { href: string; label: string };
  next?: { href: string; label: string; primary?: boolean };
  labels: { prev: string; next: string };
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border/70 pt-5">
      {prev ? (
        <Link
          href={prev.href}
          transitionTypes={["step-back"]}
          className="rounded-full px-4 py-2 text-sm text-muted-foreground transition-colors hover:bg-surface hover:text-foreground"
        >
          ← {labels.prev}: {prev.label}
        </Link>
      ) : (
        <span />
      )}
      {next && (
        <Link
          href={next.href}
          transitionTypes={["step-forward"]}
          className={cn(
            "rounded-full px-4 py-2 text-sm font-medium transition-all",
            next.primary
              ? "bg-foreground text-background shadow-card hover:-translate-y-0.5 hover:shadow-card-hover"
              : "text-foreground hover:bg-surface",
          )}
        >
          {labels.next}: {next.label} →
        </Link>
      )}
    </div>
  );
}
