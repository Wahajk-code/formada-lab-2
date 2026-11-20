"use client";

import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";

import { NumLabel } from "@/components/onboarding/term";
import { Icon } from "@/components/ui/icon";
import type { CardFull } from "@/lib/client-api";
import { num, roundMoney } from "@/lib/format";

function Spark({ series, label }: { series: CardFull["series"]; label: string }) {
  if (series.length < 2) return null;
  const w = 220,
    h = 44,
    vs = series.map((p) => p.value),
    lo = Math.min(...vs),
    hi = Math.max(...vs),
    span = hi - lo || 1;
  const pts = series.map((p, i) => [(i / (series.length - 1)) * w, h - 4 - ((p.value - lo) / span) * (h - 8)] as const);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts[pts.length - 1];
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-11 w-56 max-w-full" role="img" aria-label={label}>
      <path d={`${d} L${w},${h} L0,${h} Z`} className="fill-foreground/5" />
      <path d={d} className="fill-none stroke-foreground" strokeWidth={1.5} />
      <circle cx={lx} cy={ly} r={3} className="fill-foreground" />
    </svg>
  );
}

/** One card as the role will see it, plus the numbers and items behind it.
 *
 * audience "client": plain words in the client's language, money at their scale, counted and
 * estimated labels, no signal names or confidence decimals. "team": the same plus the technical
 * line our team reviews. */
export function CardDetail({
  card,
  open: startOpen = false,
  audience = "team",
}: {
  card: CardFull;
  open?: boolean;
  audience?: "client" | "team";
}) {
  const t = useTranslations("plain.card");
  const locale = useLocale();
  const [open, setOpen] = useState(startOpen);
  const client = audience === "client";
  const cols = card.top_items.length ? Object.keys(card.top_items[0]) : [];
  const money = (v: number) => roundMoney(v, card.impact_unit || "CAD", locale);
  const val = (v: number | null) => {
    if (v == null) return "–";
    return card.unit === "CAD" || card.unit === card.impact_unit ? money(v) : `${num(v, locale, 2)}${card.unit ? ` ${card.unit}` : ""}`;
  };
  const cell = (v: unknown) =>
    typeof v === "number" ? num(v, locale, client && Math.abs(v) >= 100 ? 0 : 2) : v == null ? "–" : String(v);
  const col = (c: string) => (t.has(`cols.${c}`) ? t(`cols.${c}`) : c.replaceAll("_", " "));

  const confidence = Math.round(card.confidence * 100);
  return (
    <article className="insight-card trial-insight" aria-label={card.title}>
      <header className="insight-card-header">
        <div className="insight-source">
          <span className="insight-source-icon">
            <Icon name="users" size={16} />
          </span>
          <span className="insight-source-copy">
            <strong>{card.role}</strong>
            {!client && card.metric && <small>{card.metric}</small>}
          </span>
        </div>
        <span className="insight-confidence">
          <Icon name="sparkles" size={14} /> {t("confidence", { n: confidence })}
        </span>
      </header>
      <div className="insight-card-body">
        <h4 className="insight-title" lang={card.language}>
          {card.title}
        </h4>
        <dl className="insight-narrative" lang={card.language}>
          <div>
            <dt>{t("whatHappened")}</dt>
            <dd>{card.what}</dd>
          </div>
          <div>
            <dt>{t("whyItMatters")}</dt>
            <dd>{card.so_what}</dd>
          </div>
          <div>
            <dt>{t("whatToDo")}</dt>
            <dd>{card.now_what}</dd>
          </div>
        </dl>
        <div className="insight-support">
          <dl className="insight-snapshot trial-snapshot">
            <div>
              <dt>{t("atStake")}</dt>
              <dd>
                {money(card.impact)} {client && <NumLabel kind="estimated" />}
              </dd>
            </div>
            <div>
              <dt>{t("now")}</dt>
              <dd>
                {val(card.current_value)} {client && <NumLabel kind="counted" />}
              </dd>
            </div>
            <div>
              <dt>{t("usual")}</dt>
              <dd>{val(card.baseline_mean)}</dd>
            </div>
          </dl>
          <details className="insight-evidence trial-evidence" open={open} onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary>
              <span>
                <Icon name="chart-bar" size={17} />
                <strong>{t("evidence")}</strong>
                <small>{card.entity ?? ""}</small>
              </span>
              <Icon name="chevron-down" size={16} />
            </summary>
            <div className="trial-evidence-content space-y-3">
              <Spark series={card.series} label={t("last", { n: card.series.length })} />
              <p>
                {card.threshold != null && (
                  <>
                    {t("alertLevel")} <b>{val(card.threshold)}</b>
                    {" · "}
                  </>
                )}
                {card.change_vs_baseline_pct != null && (
                  <>
                    {t("change")} <b>{num(card.change_vs_baseline_pct, locale, 0)}%</b>
                  </>
                )}
                {!client && ` · ${card.signal_kind ?? ""}`}
              </p>
              {card.top_items.length > 0 && (
                <>
                  <p>
                    {t("items")} {client && <NumLabel kind="counted" />}
                  </p>
                  <table>
                    <thead>
                      <tr>
                        {cols.map((c) => (
                          <th key={c} scope="col">
                            {col(c)}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {card.top_items.map((row, i) => (
                        <tr key={i}>
                          {cols.map((c, j) => (j === 0 ? <th key={c} scope="row">{cell(row[c])}</th> : <td key={c}>{cell(row[c])}</td>))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </details>
        </div>
      </div>
    </article>
  );
}
