"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent inputs and answers are schema-checked JSON */

import { ChevronDown, Copy } from "lucide-react";

import { Pill } from "@/components/onboarding/tone";

export const FIELD = "w-full rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";

export const usd = (v: number | null | undefined) => (v == null ? "–" : v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`);
export const secs = (ms: number) => (ms >= 60000 ? `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);
const n = (v: number) => v.toLocaleString("en-CA");

/** A block of JSON or text the reader can open, scroll and copy. */
export function Peek({ title, hint, value, open = false }: { title: string; hint?: string; value: unknown; open?: boolean }) {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return (
    <details open={open} className="group rounded-xl bg-surface">
      <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs font-medium">
        <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" aria-hidden />
        {title}
        {hint && <span className="font-normal text-muted-foreground">{hint}</span>}
        <button
          type="button"
          className="ml-auto inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          onClick={(e) => {
            e.preventDefault();
            void navigator.clipboard?.writeText(text).catch(() => undefined);
          }}
        >
          <Copy className="size-3" aria-hidden /> Copy
        </button>
      </summary>
      <pre className="max-h-[28rem] overflow-auto px-3 pb-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-words">{text}</pre>
    </details>
  );
}

function Counts({ checks }: { checks: any }) {
  const errors = checks?.errors?.length ?? 0;
  const warnings = checks?.warnings?.length ?? 0;
  return (
    <div className="flex flex-wrap gap-2">
      <Pill tone={errors ? "missing" : "good"}>{errors ? `${errors} errors` : "No errors"}</Pill>
      <Pill tone={warnings ? "partial" : "good"}>{warnings ? `${warnings} warnings` : "No warnings"}</Pill>
    </div>
  );
}

/** Every message code produced for one answer, errors first. */
export function CheckList({ checks }: { checks: any }) {
  if (!checks) return <p className="text-xs text-muted-foreground">No checks ran (the agent gave no usable answer).</p>;
  const perShape = Object.entries(checks.archetypes ?? {}) as [string, any][];
  return (
    <div className="space-y-2">
      <Counts checks={checks} />
      <ul className="space-y-1 text-xs">
        {(checks.errors ?? []).map((m: string, i: number) => (
          <li key={`e${i}`} className="rounded-lg bg-brand/10 px-2.5 py-1.5 text-brand">{m}</li>
        ))}
        {(checks.warnings ?? []).map((m: string, i: number) => (
          <li key={`w${i}`} className="rounded-lg bg-surface px-2.5 py-1.5">{m}</li>
        ))}
      </ul>
      {perShape.length > 0 && (
        <ul className="grid gap-2 sm:grid-cols-2">
          {perShape.map(([name, v]) => (
            <li key={name} className="rounded-xl bg-surface p-3 text-xs">
              <p className="flex items-center gap-2 font-semibold">
                {name.replaceAll("_", " ")} <Pill tone={v.ok ? "good" : "missing"}>{v.ok ? "passes" : "refused"}</Pill>
              </p>
              {v.rows != null && (
                <p className="mt-1 text-muted-foreground">
                  {n(v.rows)} rows{v.first_date ? ` · ${v.first_date} to ${v.last_date}` : ""}
                </p>
              )}
              {(v.errors ?? []).slice(0, 3).map((m: string, i: number) => (
                <p key={i} className="mt-1 text-brand">{m}</p>
              ))}
              {v.repaired_from && (
                <div className="mt-2 space-y-1.5">
                  <Pill tone="matched">Repaired once after the checks refused it</Pill>
                  {(v.repaired_from.errors ?? []).slice(0, 2).map((m: string, i: number) => (
                    <p key={i} className="text-muted-foreground">Was refused: {m}</p>
                  ))}
                  <Peek title="The refused SQL" value={v.repaired_from.sql} />
                </div>
              )}
              {(v.repair_failed ?? []).length > 0 && (
                <p className="mt-2 text-muted-foreground">One repair try did not fix it: {v.repair_failed[0]}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

