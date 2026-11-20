import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";

import { PeopleManager } from "@/components/settings/people-manager";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/client-api";
import { requireLive } from "@/lib/lifecycle-gate";

/** People and invitations (Formada.AI design): who has access and pending invitations. */
export default async function PeoplePage() {
  await requireLive();
  const me = await api.me();
  // Only owners and admins manage people; everyone else lands back on the dashboard.
  if (me.app_role === "member") redirect("/dashboard");
  const [view, t] = await Promise.all([api.people(), getTranslations("peoplePage")]);
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <PeopleManager view={view} />
    </>
  );
}
