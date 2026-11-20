"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- proposal items are schema-checked JSON */

import { Lock, LoaderCircle, PenLine, Sparkles, Unlock } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { editProposalItem, reviseProposalItem, unlockProposalItem } from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import type { ItemResult, OnboardingStep } from "@/lib/console-api";
import { cn } from "@/lib/utils";

const FIELD =
  "w-full rounded-lg bg-surface px-3 py-2 text-sm shadow-inner outline-none focus:ring-2 focus:ring-ring/40";

/** Where each step keeps its items, and how to name one. */
const SPEC: Record<string, { field: string; key: string; label: (i: any) => string; noun: string; example: string }> = {
  mapping: {
    field: "archetypes",
    key: "archetype",
    label: (i) => `${i.archetype.replaceAll("_", " ")} (${i.status})`,
    noun: "link",
    example: "e.g. also exclude locations whose name starts with Legacy",
  },
  org: {
    field: "roles",
    key: "ref",
    label: (i) => i.title,
    noun: "role",
    example: "e.g. rename to Head of Distribution, reporting to the VP Operations",
  },
  metrics: {
    field: "metrics",
    key: "key",
    label: (i) => i.name,
    noun: "measure",
    example: "e.g. for the DC manager, alert above 250,000",
  },
  rules: {
    field: "changes",
    key: "key",
    label: (i) => i.key.replaceAll("_", " "),
    noun: "setting",
    example: "e.g. lower it to 250",
  },
};

/** Change ONE item of the proposal, by asking the AI or by hand (ADR 0029). Everything else is
 * copied as it is; the item is locked, so running the full analysis again keeps it. */
export function ItemEditor({
  workspaceId,
  stepKey,
  step,
  can,
}: {
  workspaceId: string;
  stepKey: string;
  step: OnboardingStep;
  can: boolean;
}) {
  const spec = SPEC[stepKey];
  const router = useRouter();
  const out = (step.output ?? {}) as any;
  const list: any[] = spec ? (out[spec.field] ?? []) : [];
  const locked: string[] = out.locked ?? [];
  const [key, setKey] = useState<string>("");
  const [mode, setMode] = useState<"ai" | "hand">("ai");
  const [instruction, setInstruction] = useState("");
  const [json, setJson] = useState("");
  const [pending, start] = useTransition();
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  if (!spec || !list.length) return null;
  const item = list.find((i) => i[spec.key] === key);

  const pick = (k: string) => {
    setKey(k);
    setResult(null);
    const it = list.find((i) => i[spec.key] === k);
    setJson(it ? JSON.stringify(it, null, 2) : "");
  };
  const done = (res: { ok: boolean; error?: string; data?: ItemResult }) => {
    if (!res.ok) return setResult({ ok: false, text: res.error ?? "Failed" });
    const d = res.data!;
    const notes = [...d.errors.map((e) => `Error: ${e}`), ...d.warnings.map((w) => `Note: ${w}`)];
    setResult({ ok: !d.errors.length, text: `Saved as a new proposal; only this ${spec.noun} changed and it is locked.${notes.length ? " " + notes.slice(0, 3).join(" ") : ""}` });
    setInstruction("");
    router.refresh();
  };

  return (
    <section className="space-y-3 rounded-xl bg-surface/70 p-4 ring-1 ring-border/70">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h4 className="text-sm font-semibold">Change one {spec.noun}</h4>
        <p className="text-xs text-muted-foreground">
          Only that {spec.noun} changes. It is then locked: running the analysis again keeps it.
        </p>
      </div>
      {locked.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">Locked by our team:</span>
          {locked.map((k) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-full bg-card px-2 py-0.5 shadow-card">
              <Lock className="size-3" />
              {list.find((i) => i[spec.key] === k) ? spec.label(list.find((i) => i[spec.key] === k)) : k}
              {can && (
                <button
                  type="button"
                  title="Unlock: the next full analysis may change it again"
                  disabled={pending}
                  onClick={() => start(async () => done(await unlockProposalItem(workspaceId, stepKey, step.id, k)))}
                  className="ml-0.5 rounded-full p-0.5 text-muted-foreground hover:bg-surface hover:text-foreground"
                >
                  <Unlock className="size-3" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={key}
          onChange={(e) => pick(e.target.value)}
          aria-label={`Pick a ${spec.noun}`}
          className="min-w-56 flex-1 rounded-lg bg-card px-3 py-2 text-sm shadow-card outline-none ring-1 ring-border focus:ring-2 focus:ring-ring/40 sm:flex-none"
        >
          <option value="">Pick a {spec.noun}…</option>
          {list.map((i) => (
            <option key={i[spec.key]} value={i[spec.key]}>
              {spec.label(i)}
              {locked.includes(i[spec.key]) ? " (locked)" : ""}
            </option>
          ))}
        </select>
        {item && (
          <span role="radiogroup" aria-label="How to change it" className="inline-flex rounded-full bg-card p-0.5 shadow-card">
            {(
              [
                ["ai", "Ask the AI", Sparkles],
                ["hand", "Edit by hand", PenLine],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                onClick={() => setMode(m)}
                className={cn(
                  "inline-flex items-center gap-1 rounded-full px-3 py-1 text-xs font-medium transition-colors",
                  mode === m ? "bg-foreground text-background" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3" /> {label}
              </button>
            ))}
          </span>
        )}
      </div>
      {item && mode === "ai" && (
        <div className="node-pop space-y-2">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            maxLength={2000}
            placeholder={`What should change in this ${spec.noun}? ${spec.example}`}
            className={FIELD}
          />
          <Button
            size="sm"
            disabled={!can || pending || !instruction.trim()}
            onClick={() => start(async () => done(await reviseProposalItem(workspaceId, stepKey, step.id, key, instruction)))}
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <Sparkles />} Change this {spec.noun}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            The AI sees only this {spec.noun} and what it needs to change it. Code checks it again
            {stepKey === "mapping" ? " (the SQL runs against the warehouse)" : ""}.
          </p>
        </div>
      )}
      {item && mode === "hand" && (
        <div className="node-pop space-y-2">
          <textarea
            value={json}
            onChange={(e) => setJson(e.target.value)}
            rows={Math.min(18, json.split("\n").length + 1)}
            spellCheck={false}
            className={cn(FIELD, "font-mono text-xs")}
          />
          <Button
            size="sm"
            disabled={!can || pending}
            onClick={() =>
              start(async () => {
                let parsed: Record<string, unknown>;
                try {
                  parsed = JSON.parse(json);
                } catch {
                  setResult({ ok: false, text: "That is not valid JSON." });
                  return;
                }
                done(await editProposalItem(workspaceId, stepKey, step.id, key, parsed));
              })
            }
          >
            {pending ? <LoaderCircle className="animate-spin" /> : <PenLine />} Save this {spec.noun}
          </Button>
        </div>
      )}
      {result && (
        <p className={cn("text-xs", result.ok ? "text-muted-foreground" : "text-brand")}>{result.text}</p>
      )}
    </section>
  );
}
