"use client";

import { LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";

import { importMicrosoft } from "@/app/onboarding-actions";

export function MicrosoftImport({
  tenant,
  state,
  error,
}: {
  tenant: string;
  state: string;
  error: string | null;
}) {
  const t = useTranslations("notifications");
  const router = useRouter();
  const [failed, setFailed] = useState<string | null>(error);
  const started = useRef(false);

  useEffect(() => {
    if (started.current || error) return;
    started.current = true;
    importMicrosoft(tenant, state).then((res) => {
      if (res.ok) router.replace("/onboarding/organisation");
      else setFailed(res.error);
    });
  }, [tenant, state, error, router]);

  return (
    <div className="mx-auto max-w-md animate-rise space-y-3 py-16 text-center">
      {failed ? (
        <>
          <p className="text-sm text-brand">
            {t("microsoftFailed", { error: failed })}
          </p>
          <Link
            href="/onboarding/organisation"
            className="text-sm underline underline-offset-2"
          >
            {t("back")}
          </Link>
        </>
      ) : (
        <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <LoaderCircle className="size-4 animate-spin" /> {t("microsoft")}
        </p>
      )}
    </div>
  );
}
