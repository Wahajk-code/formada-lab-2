"use client";

import Link from "next/link";
import { useState } from "react";

import { cn } from "@/lib/utils";

export type Bar = { key: string; label: string; value: number; display: string; sub?: string; href?: string };

/** Horizontal magnitude bars, one ink: 12px thick, rounded data end, value at the tip.
 *  Hover or focus raises the row and shows its detail line. */
export function BarList({ bars, empty }: { bars: Bar[]; empty?: string }) {
  const [active, setActive] = useState<string | null>(null);
  const max = Math.max(...bars.map((b) => Math.abs(b.value)), 1);
  if (!bars.length) return <p className="py-6 text-center text-sm text-muted-foreground">{empty}</p>;

  return (
    <ul className="space-y-3" onPointerLeave={() => setActive(null)}>
      {bars.map((b, i) => {
        const pct = Math.max(2, (Math.abs(b.value) / max) * 100);
        const body = (
          <>
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="min-w-0 truncate">{b.label}</span>
              <span className="shrink-0 font-semibold tabular-nums">{b.display}</span>
            </div>
            <div className="mt-1.5 h-3 rounded-r bg-surface">
              <div
                className={cn(
                  "h-full rounded-r transition-all duration-700 ease-out",
                  active === null || active === b.key ? "bg-iris" : "bg-iris/30",
                )}
                style={{ width: `${pct}%`, transitionDelay: `${i * 60}ms` }}
              />
            </div>
            {b.sub && (
              <p
                className={cn(
                  "mt-1 text-xs text-muted-foreground transition-opacity duration-200",
                  active === b.key ? "opacity-100" : "opacity-70",
                )}
              >
                {b.sub}
              </p>
            )}
          </>
        );
        const props = {
          onPointerEnter: () => setActive(b.key),
          onFocus: () => setActive(b.key),
          onBlur: () => setActive(null),
          className: "block rounded-lg p-1.5 -m-1.5 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring/40",
        };
        return (
          <li key={b.key}>
            {b.href ? (
              <Link href={b.href} {...props}>
                {body}
              </Link>
            ) : (
              <div tabIndex={0} {...props}>
                {body}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
