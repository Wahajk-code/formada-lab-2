import "server-only";

import { redirect } from "next/navigation";

import { api } from "@/lib/client-api";

/** Pages that only make sense once the workspace is live (cards, org web, ledger...). While the
 * workspace is onboarding, the client sees onboarding, settings and notifications (ADR 0027). */
export async function requireLive() {
  const me = await api.me();
  if (me.tenant.lifecycle === "onboarding") redirect("/onboarding");
  return me;
}
