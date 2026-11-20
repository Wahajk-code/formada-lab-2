import { getLocale, getTranslations } from "next-intl/server";

import { CardActions } from "@/components/cards/card-actions";
import { EvidenceChart } from "@/components/cards/evidence-chart";
import { TranslateCard } from "@/components/cards/translate-card";
import { NumLabel } from "@/components/onboarding/term";
import { Status } from "@/components/ui/status";
import type { Card } from "@/lib/client-api";
import { dateTime, day, money, num, withUnit } from "@/lib/format";
import { cn } from "@/lib/utils";

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-card px-3 py-2 shadow-card">
      <div className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-1 sm:grid-cols-[7rem_1fr] sm:gap-4">
      <h3 className="pt-0.5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </h3>
      <div className="text-[15px] leading-relaxed">{children}</div>
    </section>
  );
}

function Meta({ label, value, mono = false }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 truncate font-mono text-[11px]" : "mt-0.5 text-sm"} title={typeof value === "string" ? value : undefined}>
        {value}
      </dd>
    </div>
  );
}

export async function CardDetail({ card, canAct, roleTitle }: { card: Card; canAct: boolean; roleTitle: string }) {
  const [t, tm, locale] = await Promise.all([getTranslations("cards"), getTranslations("meta"), getLocale()]);
  const e = card.evidence;
  const confidence = Math.round(Number(card.confidence) * 100);
  // Scalar drivers read as "label: value"; top_items (ADR 0028) is a table of the items behind it.
  const drivers = Object.entries(e.drivers ?? {}).filter(([k]) => k !== "top_items");
  const topItems = ((e.drivers as Record<string, unknown> | undefined)?.top_items ?? []) as Record<
    string,
    string | number | null
  >[];
  const itemCols = topItems.length ? Object.keys(topItems[0]) : [];
  const tp = await getTranslations("plain.card");
  const unit = t.has(`units.${e.unit}`) ? t(`units.${e.unit}`) : e.unit;
  const value = (v: number) => withUnit(v, e.unit === "CAD" ? "CAD" : unit, locale);
  const driverLabel = (k: string) =>
    t.has(`driverLabels.${k}`) ? t(`driverLabels.${k}`) : k.replaceAll("_", " ");
  const isThreshold = e.signal_kind === "threshold" && e.threshold !== null;

  return (
    <article key={card.id} className="animate-rise overflow-hidden rounded-2xl bg-surface shadow-card">
      <header className="space-y-4 border-b border-border/70 bg-card px-4 pt-5 pb-5 sm:px-6">
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          {e.signal_kind && (
            <span className="rounded-full bg-foreground px-2.5 py-1 font-medium text-background">
              {t(`kind.${e.signal_kind}`)}
            </span>
          )}
          <span className="rounded-full bg-surface px-2.5 py-1">{e.metric}</span>
          {card.status !== "open" && <Status value={card.status} />}
          <span className="ml-auto">{t("expires", { date: day(card.expires_at, locale) })}</span>
        </div>
        <h2 className="text-xl font-semibold leading-snug tracking-tight" lang={card.language}>
          {card.title}
        </h2>
        <div className="flex flex-wrap items-end gap-6">
          <div>
            <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              {t("impact")} <NumLabel kind="estimated" />
            </div>
            <div className="text-2xl font-semibold tabular-nums tracking-tight">
              {money(card.expected_impact, card.impact_unit, locale)}
            </div>
          </div>
          <div className="min-w-40 flex-1 sm:max-w-56">
            <div className="flex justify-between text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
              <span>{t("confidence")}</span>
              <span className="tabular-nums">{confidence}%</span>
            </div>
            <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-surface-strong">
              <div className="h-full rounded-full bg-foreground transition-all duration-700" style={{ width: `${confidence}%` }} />
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-5 px-4 py-5 sm:px-6" lang={card.language}>
        <Section label={t("what")}>{card.what}</Section>
        <Section label={t("soWhat")}>{card.so_what}</Section>
        <Section label={t("nowWhat")}>
          <p className="font-medium">{card.now_what}</p>
          {card.decision_used && (
            <p className="mt-2 inline-flex items-center gap-1.5 rounded-full bg-card px-2.5 py-1 text-xs text-muted-foreground shadow-card">
              {t("decision")}: <span className="font-medium text-foreground">{card.decision_used}</span>
            </p>
          )}
        </Section>
      </div>

      <TranslateCard cardId={card.id} cardLanguage={card.language} />

      <section className="mx-4 mb-4 space-y-4 rounded-xl bg-card p-4 shadow-card">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
          <h3 className="text-sm font-semibold">
            {t("evidence")} · <span className="font-normal text-muted-foreground">{e.entity}</span>
          </h3>
          <span className="text-xs text-muted-foreground">{t("evidenceHint", { weeks: e.baseline_weeks })}</span>
        </div>
        <EvidenceChart evidence={e} />
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Stat label={t("current")} value={value(e.recent_mean ?? e.current_value)} />
          {isThreshold ? (
            <>
              <Stat label={t("threshold")} value={value(e.threshold as number)} />
              <Stat label={t("excess")} value={value(e.excess_over_threshold ?? 0)} />
              <Stat label={t("baseline")} value={value(e.baseline_mean)} />
            </>
          ) : (
            <>
              <Stat label={t("baseline")} value={value(e.baseline_mean)} />
              <Stat
                label={t("change")}
                value={e.change_vs_baseline_pct !== null ? `${num(e.change_vs_baseline_pct, locale)} %` : "–"}
              />
            </>
          )}
        </div>
        {drivers.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{t("drivers")}</h4>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {drivers.flatMap(([, values]) =>
                Object.entries(values ?? {})
                  .filter(([, v]) => v === null || typeof v !== "object")
                  .map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 border-b border-dashed border-border py-1">
                    <dt className="text-muted-foreground">{driverLabel(k)}</dt>
                    <dd className="font-medium tabular-nums">{typeof v === "number" ? num(v, locale) : String(v)}</dd>
                  </div>
                  )),
              )}
            </dl>
          </div>
        )}
        {topItems.length > 0 && (
          <div className="space-y-1.5">
            <h4 className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">{tp("items")}</h4>
            <div className="overflow-x-auto rounded-xl bg-surface">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    {itemCols.map((c) => (
                      <th key={c} className={cn("p-2 font-medium", !["item", "vendor", "unit"].includes(c) && "text-right")}>
                        {tp.has(`cols.${c}`) ? tp(`cols.${c}`) : c.replaceAll("_", " ")}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {topItems.map((row, i) => (
                    <tr key={i} className="border-t border-border/50">
                      {itemCols.map((c) => (
                        <td key={c} className={cn("p-2", typeof row[c] === "number" && "text-right tabular-nums")}>
                          {typeof row[c] === "number"
                            ? num(row[c] as number, locale, Math.abs(row[c] as number) >= 100 ? 0 : 1)
                            : (row[c] ?? "–")}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>

      <details className="group mx-4 mb-4 rounded-xl bg-card shadow-card">
        <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-semibold [&::-webkit-details-marker]:hidden">
          <span className="inline-block text-muted-foreground transition-transform group-open:rotate-90">›</span>
          {tm("title")}
        </summary>
        <div className="space-y-3 border-t border-border/60 p-4">
        {e.source?.sql && (
          <details className="group text-sm">
            <summary className="cursor-pointer list-none text-muted-foreground transition-colors hover:text-foreground">
              <span className="inline-block transition-transform group-open:rotate-90">›</span> {t("viewSql")}
            </summary>
            <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-foreground p-3 font-mono text-[11px] leading-relaxed text-background">
              {e.source.sql.trim()}
            </pre>
          </details>
        )}
        <p className="text-xs text-muted-foreground">
          {e.signal_kind ? tm(`kindExplain.${e.signal_kind}`) : tm("kindUnknown")}
        </p>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
          <Meta label={tm("role")} value={roleTitle} />
          <Meta label={tm("entity")} value={e.entity} />
          <Meta label={tm("metric")} value={`${e.metric} (${unit})`} />
          <Meta label={tm("detected")} value={dateTime(card.created_at, locale)} />
          <Meta label={tm("dataWeek")} value={day(e.current_week, locale)} />
          <Meta label={tm("baselineWindow")} value={tm("weeks", { recent: e.recent_weeks ?? 3, baseline: e.baseline_weeks })} />
          <Meta label={tm("pointZ")} value={num(e.point_zscore ?? null, locale, 2)} />
          <Meta label={tm("wow")} value={e.week_over_week_pct != null ? `${num(e.week_over_week_pct, locale)} %` : "–"} />
          <Meta label={tm("exposure")} value={num(e.exposure ?? null, locale)} />
          <Meta label={tm("writtenBy")} value={card.generated_by ?? "–"} />
          <Meta label={tm("window")} value={card.suggested_window_days ? tm("days", { n: card.suggested_window_days }) : "–"} />
          <Meta label={tm("language")} value={card.language.toUpperCase()} />
          <div className="col-span-2 sm:col-span-3">
            <Meta label={tm("fingerprint")} value={card.fingerprint} mono />
          </div>
        </dl>
        <p className="text-xs text-muted-foreground">{tm("numbersNote")}</p>
        </div>
      </details>

      <footer className="flex flex-wrap items-center gap-2 border-t border-border/70 px-4 py-4 sm:px-6">
        {card.status !== "open" ? (
          <p className="text-sm text-muted-foreground">{t("closed")}</p>
        ) : canAct ? (
          <CardActions cardId={card.id} cardTitle={card.title} />
        ) : (
          <p className="text-sm text-muted-foreground">{t("viewerOnly")}</p>
        )}
      </footer>
    </article>
  );
}
