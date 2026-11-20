"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

import { CardDetail } from "@/components/onboarding/card-detail";
import { Icon } from "@/components/ui/icon";
import type { ClientTrial as Trial } from "@/lib/client-api";

/** The first run (Formada.AI design): stats, the verdict, and every card as its role will see it.
 * Refreshes while the run is still going. */
export function ClientTrial({ trial }: { trial: Trial }) {
  const t = useTranslations("setup.live");
  const router = useRouter();
  const running = trial.run?.status === "running";
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => router.refresh(), 3000);
    return () => clearInterval(id);
  }, [running, router]);

  if (!trial.run)
    return (
      <section className="stage-panel">
        <div className="stage-empty">
          <span className="stage-heading-icon">
            <Icon name="chart" size={23} />
          </span>
          <h3>{t("title")}</h3>
          <p>{t("waiting")}</p>
        </div>
      </section>
    );

  const roles = new Set(trial.cards.map((c) => c.role)).size;
  const has = trial.cards.length > 0;
  return (
    <>
      <div className="stage-stats">
        <div className="stage-panel stage-stat">
          <span className="stage-stat-icon">
            <Icon name="network" size={17} />
          </span>
          <small>{t("rolesPassed")}</small>
          <strong>{roles}</strong>
          <span className="stage-stat-foot">{t("rolesFoot")}</span>
        </div>
        <div className="stage-panel stage-stat">
          <span className="stage-stat-icon">
            <Icon name="sparkles" size={17} />
          </span>
          <small>{t("cards")}</small>
          <strong>{trial.cards.length}</strong>
          <span className="stage-stat-foot">{t("cardsFoot")}</span>
        </div>
      </div>
      <section className="stage-panel stage-content-panel">
        <div className="stage-panel-heading">
          <span className="stage-heading-icon">
            <Icon name={running ? "activity" : "check-circle"} size={19} />
          </span>
          <div>
            <h3>{running ? t("title") : has ? t("ready") : t("readyEmpty")}</h3>
            <p>{running ? t("waiting") : has ? t("readyBody") : t("readyEmptyBody")}</p>
          </div>
          <span className={`stage-badge ${running ? "accent" : "positive"}`}>{running ? "…" : t("reviewBadge")}</span>
        </div>
        {has && (
          <div className="trial-insight-section">
            <h4>{t("previews")}</h4>
            <div className="stage-trial-cards">
              {trial.cards.map((c, i) => (
                <CardDetail key={c.id} card={c} open={i === 0} audience="client" />
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
