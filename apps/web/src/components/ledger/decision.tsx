"use client";

import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { decideInitiative } from "@/app/actions";
import { Button } from "@/components/ui/button";

/** End of window: the owner answers one question, keep doing this or stop. */
export function Decision({ initiativeId }: { initiativeId: string }) {
  const t = useTranslations("ledger");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const choose = (choice: "keep" | "stop") =>
    start(async () => {
      const res = await decideInitiative(initiativeId, choice);
      if (!res.ok) return setError(res.error);
      router.refresh();
    });
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs font-medium">{t("question")}</span>
      <Button size="xs" onClick={() => choose("keep")} disabled={pending}>
        {t("keep")}
      </Button>
      <Button size="xs" variant="outline" onClick={() => choose("stop")} disabled={pending}>
        {t("stop")}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
