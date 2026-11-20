"use client";

import { LoaderCircle, Send, Undo2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useState, useTransition } from "react";

import { submitOrgDraft, withdrawOrgDraft } from "@/app/onboarding-actions";
import { Button } from "@/components/ui/button";
import type { OrgDraft } from "@/lib/client-api";

/** Send the chart to the team, or take it back to edit. */
export function DraftActions({ draft }: { draft: OrgDraft }) {
  const t = useTranslations("onboarding.org");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const act = (fn: typeof submitOrgDraft) =>
    start(async () => {
      const res = await fn();
      setError(res.ok ? null : res.error);
      router.refresh();
    });
  if (draft.status === "approved" || !draft.nodes.length) return null;
  return (
    <div className="flex flex-wrap items-center gap-3">
      {draft.status === "draft" ? (
        <Button onClick={() => act(submitOrgDraft)} disabled={pending}>
          {pending ? <LoaderCircle className="animate-spin" /> : <Send />}{" "}
          {t("submit")}
        </Button>
      ) : (
        <Button
          variant="outline"
          onClick={() => act(withdrawOrgDraft)}
          disabled={pending}
        >
          {pending ? <LoaderCircle className="animate-spin" /> : <Undo2 />}{" "}
          {t("withdraw")}
        </Button>
      )}
      {error && <span className="text-sm text-brand">{error}</span>}
    </div>
  );
}
