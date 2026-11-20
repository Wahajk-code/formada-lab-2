import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { Icon } from "@/components/ui/icon";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/client-api";
import { dateTime } from "@/lib/format";
import { requireLive } from "@/lib/lifecycle-gate";

/** Runs (Formada.AI design, view only for customers): the run history and the detail of one run. */
export default async function RunsPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  await requireLive();
  const [{ run }, me, dash, t, locale] = await Promise.all([searchParams, api.me(), api.dashboard(), getTranslations("runsPage"), getLocale()]);
  const runs = dash.runs;
  const selected = runs.find((r) => r.id === run) ?? runs[0] ?? null;
  const tag = (s: string) => (s === "failed" || s === "partial" ? "dw-tag" : s === "running" ? "dw-tag dw-tag-iris" : "dw-tag dw-tag-positive");
  return (
    <>
      <PageHeader role={me.roles[0]?.title} refresh title={t("title")} subtitle={t("subtitle")} />
      <div className="dw-runs-grid">
        <section className="dw-list-shell">
          <div className="dw-section-head">
            <h2>{t("history")}</h2>
          </div>
          {runs.length ? (
            <div className="dw-records">
              {runs.map((r) => (
                <Link key={r.id} href={`/runs?run=${r.id}`} className="dw-record dw-run-row" aria-current={selected?.id === r.id ? "true" : undefined}>
                  <span className="dw-record-title">
                    <strong>{t(`type.${r.type}`)}</strong>
                    <small>{dateTime(r.started_at, locale)}</small>
                  </span>
                  <span className={tag(r.status)}>{t(`status.${r.status}`)}</span>
                </Link>
              ))}
            </div>
          ) : (
            <p className="dw-quiet">{t("empty")}</p>
          )}
        </section>
        <section className="dw-list-shell">
          <div className="dw-section-head">
            <h2>{t("details")}</h2>
          </div>
          {selected ? (
            <dl className="insight-snapshot dw-initiative-snapshot dw-run-detail">
              <div>
                <dt>{t("kind")}</dt>
                <dd>{t(`type.${selected.type}`)}</dd>
              </div>
              <div>
                <dt>{t("statusLabel")}</dt>
                <dd>
                  <span className={tag(selected.status)}>{t(`status.${selected.status}`)}</span>
                </dd>
              </div>
              <div>
                <dt>{t("started")}</dt>
                <dd>{dateTime(selected.started_at, locale)}</dd>
              </div>
              <div>
                <dt>{t("ended")}</dt>
                <dd>{selected.ended_at ? dateTime(selected.ended_at, locale) : "—"}</dd>
              </div>
            </dl>
          ) : (
            <p className="dw-quiet">{t("selectRun")}</p>
          )}
          <p className="dw-quiet">
            <Icon name="info-circle" size={14} /> {t("viewOnly")}
          </p>
        </section>
      </div>
    </>
  );
}
