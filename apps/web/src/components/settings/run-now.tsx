"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { runNow } from "@/app/actions";
import { Button } from "@/components/ui/button";

/** POST /api/runs: asks n8n to run WF1 for this workspace now. */
export function RunNow() {
  const t = useTranslations("usage");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            const res = await runNow();
            setMessage(res.ok ? t("started") : res.error);
            if (res.ok) setTimeout(() => router.refresh(), 4000);
          })
        }
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <Play />} {t("runNow")}
      </Button>
      {message && <span className="text-xs text-muted-foreground">{message}</span>}
    </div>
  );
}
