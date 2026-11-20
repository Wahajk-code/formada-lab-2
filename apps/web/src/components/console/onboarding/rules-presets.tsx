"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { applyRulesPreset } from "@/app/console-actions";
import { cn } from "@/lib/utils";

/** Same values as PRESETS in apps/api/app/domain/config.py. */
const PRESETS = {
  fewer: { label: "Fewer", min_signal_impact: 1000, max_open_cards_per_role: 3, top_signals_per_role: 5, help: "Only the biggest problems" },
  balanced: { label: "Balanced", min_signal_impact: 250, max_open_cards_per_role: 5, top_signals_per_role: 8, help: "Store-level problems too" },
  more: { label: "More", min_signal_impact: 100, max_open_cards_per_role: 8, top_signals_per_role: 12, help: "Almost everything" },
} as const;
type Name = keyof typeof PRESETS;

/** Business rules inside Role metrics (decision 2): one click sets the money floor, cards per
 * person and problems reviewed per person. Fine-tune in the rules editor or Config & rules. */
export function RulesPresets({
  workspaceId,
  overrides,
  currency,
  can,
}: {
  workspaceId: string;
  overrides: { key: string; value: unknown }[];
  currency: string;
  can: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const value = (k: string) => overrides.find((o) => o.key === k)?.value;
  const current = (Object.keys(PRESETS) as Name[]).find((n) =>
    (["min_signal_impact", "max_open_cards_per_role", "top_signals_per_role"] as const).every((k) => Number(value(k)) === PRESETS[n][k]),
  );
  const money = (v: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
  return (
    <div className="space-y-2">
      <div role="radiogroup" aria-label="Rules preset" className="grid gap-2 sm:grid-cols-3">
        {(Object.keys(PRESETS) as Name[]).map((n) => {
          const p = PRESETS[n];
          const on = current === n;
          return (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={!can || pending}
              onClick={() =>
                start(async () => {
                  const res = await applyRulesPreset(workspaceId, n);
                  setMsg(res.ok ? `${p.label} applied.` : res.error);
                  router.refresh();
                })
              }
              className={cn(
                "grid gap-1 rounded-2xl border p-3 text-left transition-colors",
                on ? "border-iris bg-soft-violet" : "border-border bg-card hover:bg-surface",
              )}
            >
              <span className="flex items-center justify-between text-sm font-extrabold">
                {p.label}
                {on && <span className="tag tag-iris">Current</span>}
              </span>
              <span className="text-xs text-muted-foreground">
                {p.help}: over {money(p.min_signal_impact)}, up to {p.max_open_cards_per_role} cards each
              </span>
            </button>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        {current ? "" : "Custom values are set. "}
        {msg ?? "Fine-tune single rules below, or later in Config & rules."}
      </p>
    </div>
  );
}
