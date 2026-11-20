import { getTranslations } from "next-intl/server";

import { OrgBuilder } from "@/components/onboarding/org-builder";
import { PageHeader } from "@/components/ui/page-header";
import { api, type DraftNode, type OrgDraft } from "@/lib/client-api";
import { requireLive } from "@/lib/lifecycle-gate";

/** Org Web (Formada.AI design): the reporting structure as the builder's read-only tree, with the
 * live detail of each role (what it decides, its measures, its open cards) in the properties panel. */
export default async function OrgPage() {
  await requireLive();
  const [org, t, tb] = await Promise.all([api.org(), getTranslations("org"), getTranslations("builder")]);
  const dept = new Map(org.departments.map((d) => [d.id, d.name]));
  const byId = new Map(org.roles.map((r) => [r.id, r]));
  const nodes: DraftNode[] = org.roles.map((r) => {
    const vacant = r.holder_type === "vacant" || r.holders.length === 0;
    const route = r.cards_route_to ? byId.get(r.cards_route_to)?.title : null;
    return {
      id: r.id,
      title: r.title,
      parent_id: r.parent_id,
      name: vacant ? "" : r.holders.join(", "),
      email: "",
      department: r.department_id ? (dept.get(r.department_id) ?? "") : "",
      vacant,
      sections: [
        {
          key: "profile",
          title: tb("profile"),
          icon: "file",
          rows: [
            [tb("decisionsOwned"), r.decisions_owned.join("; ")],
            [tb("decisionsForbidden"), r.decisions_forbidden.join("; ")],
            [tb("kpiNotes"), r.kpi_notes ?? ""],
            [tb("cadence"), r.cadence === "daily" ? tb("daily") : tb("weekly")],
            [tb("language"), r.language === "fr" ? "Français" : "English"],
          ],
        },
        {
          key: "metrics",
          title: tb("metrics"),
          icon: "chart",
          list: r.metrics.map((m) => `${m.name}${m.daily_check ? ` · ${tb("daily").toLowerCase()}` : ""}`),
        },
        {
          key: "cards",
          title: tb("cards"),
          icon: "sparkles",
          rows: [
            [tb("openCards"), String(r.open_cards)],
            [tb("inTeam"), String(r.open_cards_subtree)],
            ...(vacant && route ? ([[tb("routesTo"), route]] as [string, string][]) : []),
          ],
        },
      ],
    };
  });
  const draft: OrgDraft = {
    nodes,
    status: "approved",
    source: "blank",
    updated_at: null,
    updated_by: "",
    check: { ok: true, errors: [], warnings: [] },
  };
  return (
    <>
      <PageHeader title={t("title")} subtitle={t("subtitle")} />
      <OrgBuilder draft={draft} editable={false} footer={t("footer")} />
    </>
  );
}
