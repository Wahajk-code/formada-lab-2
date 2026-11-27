import { useLocale, useTranslations } from "next-intl";

import { CardActions } from "@/components/cards/card-actions";
import { EvidenceChart } from "@/components/cards/evidence-chart";
import { Icon } from "@/components/ui/icon";
import { whyLines } from "@/lib/card-why";
import type { Card } from "@/lib/client-api";
import { num, roundMoney } from "@/lib/format";

/** One insight card in the Formada.AI design (classes from src/styles/design/stages.css and
 * dashboard.css): role, confidence, what / so what / now what, the impact snapshot, supporting
 * data, and the decision actions for the role's owner. */
export function InsightCard({
  card,
  roleTitle,
  department,
  canAct,
  own = true,
}: {
  card: Card;
  roleTitle: string;
  department?: string | null;
  canAct: boolean;
  own?: boolean;
}) {
  const t = useTranslations("dash");
  const locale = useLocale();
  const e = card.evidence;
  const confidence = Math.round(Number(card.confidence) * 100);
  const value = (v: number | null | undefined) =>
    v == null ? "–" : e.unit === card.impact_unit ? roundMoney(v, card.impact_unit, locale) : `${num(v, locale, 1)} ${e.unit}`;
  const open = card.status === "open";
  // The caution comes from code, in the owner's language; the English sentence is the fallback.
  const notes = e.data_note_codes?.length ? e.data_note_codes.map((n) => t(`note.${n.code}`, n.values)) : (e.data_notes ?? []);
  const why = whyLines(card, locale);
  return (
    <article className={`insight-card dw-insight${open ? "" : " insight-card-archived"}`} aria-label={card.title}>
      <header className="insight-card-header">
        <div className="insight-source">
          <span className="insight-source-icon">
            <Icon name="users" size={16} />
          </span>
          <span className="insight-source-copy">
            <strong>{roleTitle}</strong>
            {department && <small>{department}</small>}
          </span>
        </div>
        <span className="insight-confidence">
          <Icon name="sparkles" size={14} /> {t("confidence", { n: confidence })}
        </span>
      </header>
      <div className="insight-card-body">
        <h3 className="insight-title" lang={card.language}>
          {card.title}
        </h3>
        {notes.length > 0 && (
          <div className="dw-data-check" role="note">
            <Icon name="alert-circle" size={17} />
            <div>
              <strong>{t("dataCheck")}</strong>
              <ul>
                {notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <dl className="insight-narrative" lang={card.language}>
          <div>
            <dt>{t("what")}</dt>
            <dd>{card.what}</dd>
          </div>
          <div>
            <dt>{t("soWhat")}</dt>
            <dd>{card.so_what}</dd>
          </div>
          <div>
            <dt>{t("nowWhat")}</dt>
            <dd>{card.now_what}</dd>
          </div>
        </dl>
        <div className="insight-support">
          <dl className="insight-snapshot">
            <div>
              <dt>{t("impact")}</dt>
              <dd>
                {roundMoney(card.expected_impact, card.impact_unit, locale)} <small>{card.impact_unit}</small>
              </dd>
            </div>
            <div>
              <dt>{t("current")}</dt>
              <dd>{value(e.recent_mean ?? e.current_value)}</dd>
            </div>
            <div>
              <dt>{t("usual")}</dt>
              <dd>{value(e.baseline_mean)}</dd>
            </div>
          </dl>
          <details className="insight-evidence dw-evidence dw-why">
            <summary>
              <span>
                <Icon name="info" size={17} />
                <strong>{t("whyTitle")}</strong>
              </span>
              <Icon name="chevron-down" size={16} />
            </summary>
            <ul className="dw-why-list">
              {why.map((l) => (
                <li key={l.key}>
                  {t(`why.${l.key}`, {
                    ...l.values,
                    side: l.side ? t(`why.${l.side}`) : "",
                    sideOf: l.side ? t(`why.${l.side}Of`) : "",
                  })}
                </li>
              ))}
            </ul>
          </details>
          <details className="insight-evidence dw-evidence">
            <summary>
              <span>
                <Icon name="chart-bar" size={17} />
                <strong>{t("supporting")}</strong>
                <small>{t("aggregated")}</small>
              </span>
              <Icon name="chevron-down" size={16} />
            </summary>
            <div className="dw-evidence-content">
              <div className="dw-evidence-caption">
                <span>{t("metric")}</span>
                <strong>{e.metric}</strong>
              </div>
              <EvidenceChart evidence={e} />
              <p className="dw-evidence-source">
                <Icon name="database" size={14} /> {t("weeks", { n: e.baseline_weeks })}
              </p>
            </div>
          </details>
        </div>
        <footer className="dw-insight-actions">
          {open && canAct ? (
            <>
              <CardActions cardId={card.id} cardTitle={card.title} own={own} />
              {!own && (
                <span className="dw-access-note">
                  <Icon name="info" size={15} /> {t("vacantNote")}
                </span>
              )}
            </>
          ) : (
            <span className="dw-access-note">
              <Icon name={open ? "lock" : "history"} size={15} /> {open ? t("readOnly") : t(`status.${card.status}`)}
            </span>
          )}
        </footer>
      </div>
    </article>
  );
}
