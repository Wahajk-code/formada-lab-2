"use client";

import { AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { useTranslations } from "next-intl";

import type { AnswerCheck } from "@/lib/client-api";
import { cn } from "@/lib/utils";

/** Under an AI answer: what code checked (ADR 0029). The team also sees the sources it used. */
export function AnswerCheckLine({ check, audience }: { check: AnswerCheck; audience: "team" | "client" }) {
  const t = useTranslations("plain.check");
  const flagged = check.unverified.length > 0;
  const Icon = flagged || check.grounded === "no" ? AlertTriangle : check.grounded === "partly" ? HelpCircle : CheckCircle2;
  return (
    <div className="mt-1.5 space-y-1 text-[11px]">
      <p
        className={cn(
          "flex items-start gap-1.5",
          flagged ? "text-[var(--attention-ink)]" : "text-muted-foreground",
        )}
      >
        <Icon className="mt-px size-3.5 shrink-0" />
        <span>
          {flagged ? t("unverified", { numbers: check.unverified.join(", ") }) : t(check.grounded)}
        </span>
      </p>
      {audience === "team" && check.sources.length > 0 && (
        <p className="flex flex-wrap gap-1">
          {check.sources.map((s) => (
            <span key={s} className="rounded-full bg-card px-1.5 py-px font-mono text-[10px] text-muted-foreground ring-1 ring-border">
              {s}
            </span>
          ))}
        </p>
      )}
    </div>
  );
}
