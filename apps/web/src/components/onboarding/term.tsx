"use client";

import { useTranslations } from "next-intl";

import { cn } from "@/lib/utils";

export type GlossaryKey =
  | "counted"
  | "estimated"
  | "atStake"
  | "card"
  | "alert"
  | "usual"
  | "notSellable"
  | "realCounts"
  | "roleType"
  | "preset"
  | "trial"
  | "measure";

/** A tip that opens on hover or keyboard focus. CSS only, so it works in server-rendered text. */
function Tip({ text, children, className }: { text: string; children: React.ReactNode; className?: string }) {
  return (
    <span tabIndex={0} className={cn("group/tip relative inline-flex cursor-help outline-none", className)}>
      {children}
      <span
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 w-64 -translate-x-1/2 translate-y-1 rounded-xl bg-foreground px-3 py-2 text-left text-xs font-normal normal-case leading-relaxed tracking-normal text-background opacity-0 shadow-card transition duration-150 group-hover/tip:translate-y-0 group-hover/tip:opacity-100 group-focus/tip:translate-y-0 group-focus/tip:opacity-100"
      >
        {text}
      </span>
    </span>
  );
}

/** A word with one glossary meaning, the same on both sides (ADR 0029). */
export function Term({ k, children }: { k: GlossaryKey; children: React.ReactNode }) {
  const t = useTranslations("plain.glossary");
  return (
    <Tip text={t(k)} className="underline decoration-muted-foreground/50 decoration-dotted underline-offset-4">
      {children}
    </Tip>
  );
}

/** "counted" (straight from their data) or "estimated" (our calculation, with how). */
export function NumLabel({ kind, how }: { kind: "counted" | "estimated"; how?: string }) {
  const t = useTranslations("plain");
  const text = kind === "counted" ? t("countedHow") : `${t("howWeEstimate")}: ${how ?? t("impactHow")}`;
  return (
    <Tip text={text}>
      <span
        className={cn(
          "rounded-full px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
          kind === "counted" ? "bg-surface-strong text-foreground" : "border border-dashed border-muted-foreground/60 text-muted-foreground",
        )}
      >
        {t(kind)}
      </span>
    </Tip>
  );
}

/** solid / early / not yet: how far a number or an alert can be trusted today. */
export function Level({ level }: { level: "solid" | "early" | "not_yet" | "limits" | "noted" }) {
  const t = useTranslations("plain");
  const tone = {
    solid: "bg-[var(--positive)] text-[var(--positive-ink)] ring-transparent",
    early: "bg-[var(--attention)] text-[var(--attention-ink)] ring-transparent",
    not_yet: "bg-surface text-muted-foreground ring-border",
    limits: "bg-[var(--critical)] text-[var(--critical-ink)] ring-transparent",
    noted: "bg-surface text-muted-foreground ring-border",
  }[level];
  return (
    <Tip text={t(`levelHelp.${level}`)}>
      <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium ring-1", tone)}>{t(`levels.${level}`)}</span>
    </Tip>
  );
}
