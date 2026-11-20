import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { InitiativeTrend } from "@/components/charts/initiative-trend";
import { Decision } from "@/components/ledger/decision";
import { LazyCard } from "@/components/cards/lazy-card";
import { FilterSelect } from "@/components/ui/filter-select";
import { LazyDetails } from "@/components/ui/lazy-details";
import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/ui/page-header";
import { SearchBox } from "@/components/ui/search-box";
import { api, type LedgerInitiative } from "@/lib/client-api";
import { fullDay, num, roundMoney } from "@/lib/format";
import { requireLive } from "@/lib/lifecycle-gate";

type Outcome = "improved" | "unchanged" | "worsened" | "in_progress";
const OUTCOMES: Outcome[] = ["in_progress", "improved", "unchanged", "worsened"];
const DAY = 86_400_000;
const since = (days: number) => (days ? Date.now() - days * DAY : 0);

/** What the latest review says: better, the same, or worse than the baseline. */
function outcomeOf(i: LedgerInitiative): Outcome {
  const latest = i.end ?? i.midpoint;
  if (!latest) return "in_progress";
  return latest.value_captured > 0 ? "improved" : latest.value_captured < 0 ? "worsened" : "unchanged";
}

/** Initiatives (Formada.AI design): what each role acted on, measured against its baseline. */
export default async function InitiativesPage({ searchParams }: { searchParams: Promise<{ status?: string; open?: string; q?: string; role?: string; started?: string }> }) {
  await requireLive();
  const [{ status, open, q, role, started }, me, ledger, t, locale] = await Promise.all([searchParams, api.me(), api.ledger(), getTranslations("initiatives"), getLocale()]);
  const all = ledger.initiatives.filter((i) => i.status !== "cancelled");
  const outcome = OUTCOMES.includes(status as Outcome) ? (status as Outcome) : "";
  const days = started === "30" || started === "90" || started === "365" ? Number(started) : 0;
  const roles = [...new Set(all.map((i) => i.role))].sort();
  const cutoff = since(days);
  const needle = (q ?? "").toLowerCase();
  const shown = all
    .filter((i) => !role || i.role === role)
    .filter((i) => !outcome || outcomeOf(i) === outcome)
    .filter((i) => Date.parse(i.started_on) >= cutoff)
    .filter((i) => !needle || `${i.card.title} ${i.role} ${i.owner} ${i.metric}`.toLowerCase().includes(needle))
    .sort((a, b) => b.started_on.localeCompare(a.started_on));
  const currency = ledger.currency;
  const value = (v: number, unit: string) => (unit === currency ? roundMoney(v, currency, locale) : `${num(v, locale, 1)} ${unit}`);
  const signed = (v: number) => `${v >= 0 ? "+" : "-"}${roundMoney(Math.abs(v), currency, locale)}`;
  const detail = (i: LedgerInitiative) => {
    const latest = i.end ?? i.midpoint;
    const points = [
      { label: t("baseline"), value: i.baseline_value, kind: "baseline" as const, at: i.started_on },
      ...(i.midpoint ? [{ label: t("midpoint"), value: i.midpoint.value, kind: (i.end ? "reading" : "latest") as "reading" | "latest", at: i.midpoint.measured_at }] : []),
      ...(i.end ? [{ label: t("final"), value: i.end.value, kind: "latest" as const, at: i.end.measured_at }] : []),
    ];
    const reviewAt = latest?.measured_at;
    return (
      <div className="dw-initiative-body">
        {latest && (
          <section className="ini-outcome">
            <h3>{t("outcomeTitle", { n: i.window_days })}</h3>
            <p>{t("reviewed", { date: fullDay(latest.measured_at, locale) })}</p>
            <dl>
              <div>
                <dt>{t("atReview")}</dt>
                <dd>{value(latest.value, i.unit)}</dd>
              </div>
              <div>
                <dt>{t("changeBaseline")}</dt>
                <dd>
                  {latest.delta > 0 ? "+" : ""}
                  {value(latest.delta, i.unit)}
                </dd>
              </div>
              <div>
                <dt>{t("estimatedValue")}</dt>
                <dd>
                  {signed(latest.value_captured)} <small>{currency}</small>
                </dd>
              </div>
            </dl>
            {i.keep_or_stop && (
              <p className="dw-initiative-context">
                {t("followUp")} <strong>{i.keep_or_stop === "keep" ? t("keep") : t("stop")}</strong>
              </p>
            )}
            {i.status === "done" && !i.keep_or_stop && i.owner_is_me && <Decision initiativeId={i.id} />}
          </section>
        )}
        <section className="ini-trend-block">
          <div className="ini-trend-head">
            <h3>{t("trendTitle")}</h3>
            <p>
              {i.metric}
              {i.entity ? ` · ${i.entity}` : ""} · {i.higher_is_better ? t("higherBetter") : t("lowerBetter")}
            </p>
          </div>
          <dl className="ini-targets">
            <div>
              <dt>{t("baseline")}</dt>
              <dd>{value(i.baseline_value, i.unit)}</dd>
              <small>{i.baseline_period}</small>
            </div>
            <div>
              <dt>{t("target")}</dt>
              <dd>{i.target_value == null ? "—" : value(i.target_value, i.unit)}</dd>
            </div>
          </dl>
          <InitiativeTrend
            points={points}
            baseline={i.baseline_value}
            format={(v) => value(v, i.unit)}
            legend={{
              baseline: t("legendBaseline", { date: fullDay(i.started_on, locale) }),
              review: reviewAt && i.end ? t("legendReview", { date: fullDay(reviewAt, locale) }) : null,
              latest: t("legendLatest", { date: fullDay(points[points.length - 1].at, locale) }),
            }}
          />
          {!latest && <p className="dw-initiative-context">{t("due", { date: fullDay(i.ends_on, locale) })}</p>}
        </section>
        <div className="dw-original">
          <details>
            <summary>
              {t("original")}{" "}
              <span className="dw-disclosure-label" aria-hidden="true">
                <span>{t("show")}</span>
                <span>{t("hide")}</span>
              </span>
            </summary>
            <LazyCard id={i.card.id} roleTitle={i.role} department={i.department} />
          </details>
        </div>
      </div>
    );
  };

  return (
    <>
      <PageHeader role={me.roles[0]?.title} refresh title={t("title")} subtitle={t("subtitle")} />
      <section className="dw-initiative-list">
        <div className="dw-section-head ini-head">
          <div>
            <h2>{t("tracked")}</h2>
            <p>{t("shownCount", { shown: shown.length, total: all.length })}</p>
          </div>
        </div>
        <div className="ini-filters">
          <SearchBox label={t("searchLabel")} placeholder={t("searchPlaceholder")} />
          <FilterSelect param="role" label={t("sourceRole")} value={role ?? ""} options={[["", t("allVisibleRoles")], ...roles.map((r): [string, string] => [r, r])]} />
          <FilterSelect param="started" label={t("started")} value={days ? String(days) : ""} options={[["", t("anyTime")], ["30", t("last30")], ["90", t("last90")], ["365", t("lastYear")]]} />
          <FilterSelect param="status" label={t("statusLabel")} value={outcome} options={[["", t("anyStatus")], ...OUTCOMES.map((o): [string, string] => [o, t(`outcome.${o}`)])]} />
        </div>
        {shown.length ? (
          <div className="dw-records">
            {shown.map((i) => (
              <LazyDetails
                key={i.id}
                className="dw-record dw-initiative"
                defaultOpen={open === i.id}
                summary={
                  <>
                    <span className="dw-record-title">
                      <strong>{i.card.title}</strong>
                      <small>
                        {i.role} · {i.owner}
                      </small>
                    </span>
                    <span className="ini-side">
                      <span className={`ini-pill ini-pill-${outcomeOf(i)}`}>{t(`outcome.${outcomeOf(i)}`)}</span>
                      <small>
                        {(i.end ?? i.midpoint) ? t("reviewed", { date: fullDay((i.end ?? i.midpoint)!.measured_at, locale) }) : t("due", { date: fullDay(i.ends_on, locale) })}
                      </small>
                    </span>
                    <Icon name="chevron-down" size={18} className="ini-chevron" />
                  </>
                }
              >
                {detail(i)}
              </LazyDetails>
            ))}
          </div>
        ) : (
          <section className="dw-empty">
            <span className="dw-symbol">
              <Icon name="target" size={23} />
            </span>
            <h2>{t("emptyTitle")}</h2>
            <p>{t("emptyBody")}</p>
            <Link href="/dashboard" className="btn btn-secondary">
              <Icon name="arrow-right" size={16} />
              {t("openFeed")}
            </Link>
          </section>
        )}
      </section>
    </>
  );
}
