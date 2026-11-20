import { redirect } from "next/navigation";

import { consoleApi } from "@/lib/console-api";

export default async function OnboardingIndex({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const state = await consoleApi.onboarding(id);
  redirect(`/console/workspaces/${id}/onboarding/${state.progress.current}`);
}
