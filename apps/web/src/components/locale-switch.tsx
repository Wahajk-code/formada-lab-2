"use client";

import { useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { setLocale } from "@/app/actions";
import { cn } from "@/lib/utils";

const LOCALES = ["en", "fr"] as const;

export function LocaleSwitch() {
  const current = useLocale();
  const router = useRouter();
  const [pending, start] = useTransition();

  return (
    <div className="flex rounded-full bg-surface p-0.5 text-xs font-medium" aria-busy={pending}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          onClick={() => start(async () => {
            await setLocale(l);
            router.refresh();
          })}
          className={cn(
            "rounded-full px-2.5 py-1 uppercase transition-all duration-200",
            l === current ? "bg-card shadow-card" : "text-muted-foreground hover:text-foreground",
          )}
          aria-pressed={l === current}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
