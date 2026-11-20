import { Users } from "lucide-react";
import { getLocale, getTranslations } from "next-intl/server";

import { DepartmentCard } from "@/components/dashboard/executive/department-card";
import { ExecutiveControls } from "@/components/dashboard/executive/controls";
import { ReadingTile } from "@/components/dashboard/executive/reading-tile";
import { SuggestionList } from "@/components/dashboard/executive/suggestion-list";
import { RefreshButton } from "@/components/ui/refresh-button";
import { getExecutiveOverview, type Period } from "@/mocks/executive-overview";

const YEARS = [2025, 2024, 2023];

export type ExecutiveSearch = { tab?: string; dept?: string; period?: string; year?: string };

/** The upper-management view (the CEO example): company KPIs and one card per department.
 * Readings come from `getExecutiveOverview`, mocked for now. */
export async function ExecutiveView({ search }: { search: ExecutiveSearch }) {
  const [t, locale] = await Promise.all([getTranslations("exec"), getLocale()]);
  const period: Period = search.period === "current" ? "current" : "year";
  const year = YEARS.includes(Number(search.year)) ? Number(search.year) : YEARS[0];
  const data = await getExecutiveOverview({ period, year });
  const current = period === "current";
  const showDept = search.dept && data.departments.some((d) => d.id === search.dept) ? search.dept : "all";
  const visible = data.departments.filter((d) => showDept === "all" || d.id === showDept);
  const flaggedOf = (r: { trend: string }[]) => r.filter((x) => x.trend === "attention").length;
  const needing = visible.reduce((n, d) => n + flaggedOf(d.readings), 0);
  const units = { orders: t("unit.orders"), days: t("unit.days") };
  const labels = {
    prior: t.raw("prior") as string,
    improving: t("improving"),
    attention: t("attention"),
    nextStep: t("nextStep"),
    viewSuggestion: t("viewSuggestion"),
  };
  const tab = search.tab === "suggestions" ? "suggestions" : "company";
  const deptName = data.departments.find((d) => d.id === showDept)?.name;
  const scopeName = deptName ?? t("allDepartments");
  const items = data.suggestions.filter((x) => !deptName || x.department === deptName);

  return (
    <div className="ex-page">
      <header className="ex-head">
        <div>
          <h1>{t("title")}</h1>
          <p>{t("subtitle")}</p>
        </div>
        <div className="ex-head-actions">
          <div className="ex-chip">
            <Users size={19} aria-hidden="true" />
            <span>
              <small>{t("activeRole")}</small>
              {data.activeRole}
            </span>
          </div>
          <RefreshButton label={t("refresh")} />
        </div>
      </header>

      <ExecutiveControls
        labels={{
          tabCompany: t("tabCompany"),
          tabSuggestions: t("tabSuggestions"),
          department: t("department"),
          allDepartments: t("allDepartments"),
          period: t("period"),
          byYear: t("byYear"),
          current: t("current"),
          year: t("year"),
          refresh: t("refresh"),
          tabs: t("tabs"),
        }}
        departments={data.departments.map((d) => ({ id: d.id, name: d.name }))}
        suggestionCount={data.suggestions.length}
        years={YEARS}
      />

      {tab === "company" ? (
        <div className="ex-body" key={`${period}-${year}-${showDept}`}>
          <section className="ex-panel">
            <h2>{t("kpiTitle")}</h2>
            <p className="ex-sub">{current ? `${t("demo")} · ${t("current")}` : `${t("demo")} · ${t("vs", { year, prior: year - 1 })}`}</p>
            <div className="ex-kpis dw-stagger">
              {data.kpis.map((r) => (
                <ReadingTile key={r.key} reading={r} locale={locale} units={units} labels={labels} showRole={current} showNext={current} large />
              ))}
            </div>
          </section>

          <div className="ex-section-head">
            <h2>{t("deptTitle")}</h2>
            <p>
              <span>
                <b>
                  {visible.length} / {data.departments.length}
                </b>{" "}
                {t("inView")}
              </span>
              <span>
                <b>{needing}</b> {t("needing")}
              </span>
            </p>
          </div>
          <div className="ex-depts dw-stagger">
            {visible.map((d) => {
              const flagged = flaggedOf(d.readings);
              return (
                <DepartmentCard
                  key={d.id}
                  department={d}
                  locale={locale}
                  units={units}
                  labels={labels}
                  current={current}
                  heading={t("rolesMetrics", { roles: d.roles, metrics: d.readings.length })}
                  flagged={flagged ? t("flagged", { n: flagged }) : null}
                  more={t("moreMetrics", { n: d.readings.length - 1 })}
                  fewer={t("fewer")}
                />
              );
            })}
          </div>
        </div>
      ) : (
        <section className="ex-panel ex-body" key={`s-${period}-${year}-${showDept}`}>
          <h2>{t("recommended")}</h2>
          <p className="ex-sub">{t("scopeLine", { scope: scopeName })}</p>
          {items.length ? (
            <SuggestionList
              items={items}
              locale={locale}
              units={units}
              labels={{
                impact: t("impactLine"),
                confidence: t.raw("confidence") as string,
                what: t("what"),
                soWhat: t("soWhat"),
                nowWhat: t("nowWhat"),
                expectedImpact: t("expectedImpact"),
                current: t("currentPeriod"),
                previous: t("previousPeriod"),
                supporting: t("supporting"),
                baseline: t("baseline"),
                change: t("change"),
                showMore: t("showMore"),
                showFewer: t("showFewer"),
              }}
            />
          ) : (
            <p className="ex-empty">{t("noSuggestions")}</p>
          )}
        </section>
      )}
    </div>
  );
}
