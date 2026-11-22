"use client";

import { AlertTriangle, Check, ChevronDown } from "lucide-react";
import { useState } from "react";

import type { ThreadStep } from "@/lib/client-api";
import type { OnboardingState, ReviewCheck } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/** Discovery and mapping show no checklist; their review screens carry the same facts. */
export const HAS_CHECKLIST = (step: ThreadStep) => step !== "discovery" && step !== "mapping";

/** Review by exception: checks computed by code. A warning opens in place with what to do. */
export function Checklist({
  checks,
  onDetails,
}: {
  checks: ReviewCheck[];
  onDetails: () => void;
}) {
  const failing = checks.filter((c) => !c.ok);
  const passing = checks.filter((c) => c.ok);
  const [openKey, setOpenKey] = useState<string | null>(failing.find((c) => !c.soft)?.key ?? null);
  const [showPassing, setShowPassing] = useState(false);
  if (!checks.length) return null;
  return (
    <div className="space-y-2">
      {failing.map((c) => {
        const open = openKey === c.key;
        return (
          <div
            key={c.key}
            className={cn(
              "rounded-xl ring-1 transition-colors",
              "bg-surface ring-border",
            )}
          >
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpenKey(open ? null : c.key)}
              className="flex w-full items-start gap-3 px-3 py-2.5 text-left"
            >
              <AlertTriangle className={cn("mt-0.5 size-4 shrink-0", c.soft ? "text-muted-foreground" : "text-[var(--attention-ink)]")} />
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium">
                  {c.title}
                  {c.soft && <span className="ml-2 text-[11px] font-normal text-muted-foreground">worth a look</span>}
                </span>
                <span className={cn("block text-xs text-muted-foreground", !open && "truncate")}>{c.detail}</span>
              </span>
              <ChevronDown className={cn("mt-0.5 size-4 shrink-0 transition-transform duration-200", open && "rotate-180")} />
            </button>
            {open && (
              <div className="node-pop space-y-2 border-t border-border/60 px-3 py-2.5 text-xs">
                {c.fix && (
                  <p>
                    <span className="font-semibold">What to do: </span>
                    {c.fix}
                  </p>
                )}
                <div className="flex flex-wrap gap-1.5">
                  <button
                    type="button"
                    onClick={onDetails}
                    className="rounded-full bg-card px-2.5 py-1 font-medium shadow-card hover:bg-surface"
                  >
                    See the details
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}
      {passing.length > 0 && (
        <div className="rounded-xl bg-surface/60">
          <button
            type="button"
            onClick={() => setShowPassing(!showPassing)}
            className="flex w-full items-center gap-3 px-3 py-2.5 text-left text-sm"
          >
            <Check className="size-4 shrink-0 text-[var(--jade)]" />
            <span className="min-w-0 flex-1">
              <span className="font-medium">
                {failing.length ? `${passing.length} more check${passing.length === 1 ? "" : "s"} pass` : `All ${passing.length} checks pass`}
              </span>
              {!showPassing && (
                <span className="block truncate text-xs text-muted-foreground">{passing.map((c) => c.title.toLowerCase()).join(" · ")}</span>
              )}
            </span>
            <ChevronDown className={cn("size-4 shrink-0 transition-transform duration-200", showPassing && "rotate-180")} />
          </button>
          {showPassing && (
            <ul className="node-pop space-y-1 border-t border-border/50 px-3 py-2 text-xs">
              {passing.map((c) => (
                <li key={c.key} className="flex gap-2">
                  <Check className="mt-0.5 size-3.5 shrink-0 text-[var(--jade)]" />
                  <span>
                    <span className="font-medium">{c.title}</span> <span className="text-muted-foreground">· {c.detail}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** Approving past an open warning needs a one-line reason (audited). */
export function blockingChecks(state: OnboardingState, step: ThreadStep) {
  if (!HAS_CHECKLIST(step)) return [];
  return (state.review?.checklists[step] ?? []).filter((c) => !c.ok && !c.soft);
}
