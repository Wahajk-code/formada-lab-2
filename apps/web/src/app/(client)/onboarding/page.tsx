import { redirect } from "next/navigation";

import { api } from "@/lib/client-api";

export default async function OnboardingIndex() {
  const ob = await api.onboarding();
  if (ob.member) return null; // the layout explains the workspace is being set up
  redirect(`/onboarding/${ob.current}`);
}
