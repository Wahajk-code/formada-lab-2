import { Info } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { FilterSelect } from "@/components/ui/filter-select";
import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/ui/page-header";
import { api, type LedgerInitiative } from "@/lib/client-api";
import { fullDay, num, roundMoney } from "@/lib/format";
import { requireLive } from "@/lib/lifecycle-gate";

type Family = "cost" | "efficiency" | "revenue";
const FAMILIES: Family[] = ["cost", "efficiency", "revenue"];
const COSTY = /cost|spend|expense|freight|labou?r|shrink|waste/i;

/** The three outcome families of the design. A money metric is a cost when its name reads like spend
 * and revenue otherwise; every other unit (orders, days, units) is operational efficiency. */
function familyOf(i: LedgerInitiative, currency: string): Family {
  if (i.unit === currency) return COSTY.test(i.metric) ? "cost" : "revenue";
  return "efficiency";
}

/** Value ledger (Formada.AI design): how the business metrics a role tracks moved from their baselines. */
export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ scope?: string }> }) {
  await requireLive();
  const { scope: rawScope } = await searchParams;
  const [me, l, t, locale] = await Promise.all([api.me(), api.ledger(), getTranslations("ledgerPage"), getLocale()]);
  const cur = l.currency;
  const measured = l.initiatives.filter((i) => i.end ?? i.midpoint);
  const departments = [...new Set(measured.map((i) => i.department).filter((d): d is string => !!d))].sort();
  const rolesList = [...new Set(measured.map((i) => i.role))].sort();
  const scope = rawScope && (rawScope.startsWith("d:") ? departments.includes(rawScope.slice(2)) : rawScope.startsWith("r:") && rolesList.includes(rawScope.slice(2))) ? rawScope : "company";
  const inScope = (i: LedgerInitiative) => scope === "company" || (scope.startsWith("d:") ? i.department === scope.slice(2) : i.role === scope.slice(2));
  const entries = measured.filter(inScope);
  const latestOf = (i: LedgerInitiative) => (i.end ?? i.midpoint)!;
  const fmt = (v: number, unit: string, signed = false) => {
    const s = v < 0 ? "-" : signed && v > 0 ? "+" : "";
    return unit === cur ? `${s}${roundMoney(Math.abs(v), cur, locale)}` : `${s}${num(Math.abs(v), locale, 2)} ${unit}`;
  };
  const verdict = (v: number) => (v > 0 ? "improved" : v < 0 ? "worsened" : "unchanged");
  const byFamily = new Map<Family, LedgerInitiative[]>(FAMILIES.map((f) => [f, entries.filter((i) => familyOf(i, cur) === f).sort((a, b) => latestOf(b).measured_at.localeCompare(latestOf(a).measured_at))]));
  const scopeOptions: [string, string][] = [
    ["company", t("company")],
    ...departments.map((d): [string, string] => [`d:${d}`, d]),
    ...rolesList.map((r): [string, string] => [`r:${r}`, r]),
  ];

  return (
    <>
      <PageHeader role={me.roles[0]?.title} refresh title={t("title")} subtitle={t("subtitle")} />
      <section className="led-panel">
        <div className="led-head">
          <div>
            <h2>{t("observed")}</h2>
            <p>{t("observedBody")}</p>
          </div>
          <FilterSelect param="scope" label={t("scope")} value={scope} fallback="company" options={scopeOptions} />
        </div>

        <div className="led-kpis dw-stagger">
          {FAMILIES.map((f) => {
            const top = byFamily.get(f)![0];
            return (
              <article key={f} className="led-kpi">
                <p>{t(`family.${f}`)}</p>
                {top ? (
                  <>
                    <strong>{fmt(latestOf(top).value, top.unit)}</strong>
                    <small>
                      {top.metric} · {top.role}
                    </small>
                    <div className="led-kpi-foot">
                      <span>{t("baselineValue", { v: fmt(top.baseline_value, top.unit) })}</span>
                      <span>{fmt(latestOf(top).delta, top.unit, true)}</span>
                      <span className={`ini-pill ini-pill-${verdict(latestOf(top).value_captured)}`}>{t(`verdict.${verdict(latestOf(top).value_captured)}`)}</span>
                    </div>
                  </>
                ) : (
                  <small>{t("noReading")}</small>
                )}
              </article>
            );
          })}
        </div>

        <p className="led-note">
          <Info size={16} aria-hidden="true" />
          <span>
            <b>{t("attributedTitle")}</b> · {t("attributedBody")}
          </span>
        </p>

        <div className="led-cols dw-stagger">
          {FAMILIES.map((f) => {
            const items = byFamily.get(f)!;
            return (
              <section key={f} className="led-col">
                <h3>{t(`family.${f}`)}</h3>
                <p>{t(`familyBody.${f}`)}</p>
                {items.length ? (
                  <ul>
                    {items.map((i) => {
                      const m = latestOf(i);
                      return (
                        <li key={i.id}>
                          <div className="led-item-top">
                            <strong>{i.metric}</strong>
                            <b>{fmt(m.delta, i.unit, true)}</b>
                          </div>
                          <div className="led-item-mid">
                            <small>
                              {i.role} · {fullDay(m.measured_at, locale)}
                            </small>
                            <span className={`ini-pill ini-pill-${verdict(m.value_captured)}`}>{t(`verdict.${verdict(m.value_captured)}`)}</span>
                          </div>
                          <Link href={`/initiatives?open=${i.id}`} className="dw-text-link">
                            <Icon name="arrow-right" size={16} />
                            {t("view")}
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                ) : (
                  <p className="led-empty">{t("noOutcomes")}</p>
                )}
              </section>
            );
          })}
        </div>
      </section>
    </>
  );
}
