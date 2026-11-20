/* eslint-disable @next/next/no-img-element -- static brand mark */
import Link from "next/link";

import { Icon } from "@/components/ui/icon";
import type { Checkin, ClientStep, ClientStepKey } from "@/lib/client-api";

/** Client onboarding pieces from the Formada.AI design (classes from src/styles/design). */

export const STEP_ICON: Record<ClientStepKey, string> = {
  connect: "snowflake",
  prepare: "database",
  org: "network",
  metrics: "chart",
  live: "play",
};

export function SetupStepper({
  steps,
  current,
  names,
  statuses,
}: {
  steps: ClientStep[];
  current: ClientStepKey;
  names: Record<string, string>;
  statuses: Record<string, string>;
}) {
  return (
    <nav className="stepper customer-stepper" aria-label="Onboarding steps">
      <ol>
        {steps.map((s) => {
          const done = s.status === "done";
          const selected = s.key === current;
          const inner = (
            <>
              <span className="step-icon">
                <Icon name={done ? "check" : STEP_ICON[s.key]} size={19} />
              </span>
              <span className="step-name">{names[s.key]}</span>
              <span className="step-status">{statuses[s.status]}</span>
            </>
          );
          return (
            <li key={s.key} className={`step-item ${selected ? "selected" : ""} ${done ? "complete" : ""}`}>
              {s.can_open ? (
                <Link href={`/onboarding/${s.key}`} aria-current={selected ? "step" : undefined} className="step-link">
                  {inner}
                </Link>
              ) : (
                <button type="button" disabled aria-label={`${names[s.key]}, ${statuses[s.status]}`}>
                  {inner}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function StepTag({ status, label }: { status: string; label: string }) {
  const tone =
    status === "done" ? "tag-positive" : status === "upcoming" ? "" : status === "with_formada" ? "tag-iris" : "tag-attention";
  return <span className={`tag ${tone}`}>{label}</span>;
}

export function LockedCard({ eyebrow, title, body, back, href }: { eyebrow: string; title: string; body: string; back: string; href: string }) {
  return (
    <div className="locked-card">
      <span className="locked-icon">
        <Icon name="lock" size={24} />
      </span>
      <p className="eyebrow">{eyebrow}</p>
      <h3>{title}</h3>
      <p>{body}</p>
      <Link href={href} className="btn btn-primary">
        <Icon name="arrow-left" size={17} />
        <span>{back}</span>
      </Link>
    </div>
  );
}

function Badge({ tone, icon, children }: { tone: "positive" | "accent" | "attention"; icon: string; children: React.ReactNode }) {
  return (
    <span className={`stage-badge ${tone}`}>
      <Icon name={icon} size={13} />
      {children}
    </span>
  );
}

export function ConnectionGraphic({ verified, readOnly }: { verified: boolean; readOnly: string }) {
  return (
    <div className="connection-graphic" role="img" aria-label={readOnly}>
      <div className="connection-link" aria-hidden="true">
        <i />
        <i />
        <i />
        <i />
        <i />
      </div>
      <div className="connection-station">
        <div className="connection-tile warehouse-tile">
          <Icon name="snowflake" size={29} />
        </div>
        <span>Snowflake</span>
      </div>
      <div className="connection-station">
        <div className="connection-tile formada-tile">
          <img src="/brand/formada-mark.svg" width={31} height={31} alt="" />
          {verified && (
            <span className="connection-verified">
              <Icon name="check" size={13} />
            </span>
          )}
        </div>
        <span>Formada.AI</span>
      </div>
      <span className="connection-guard">
        <Icon name="lock" size={11} /> {readOnly}
      </span>
    </div>
  );
}

type T = (key: string) => string;

export function ConnectStory({ verified, t }: { verified: boolean; t: T }) {
  return (
    <section className="stage-panel connection-panel" aria-labelledby="customer-connection-title">
      <div className={`connection-story customer-progress-story ${verified ? "is-ready" : ""}`}>
        <div className="connection-copy">
          <Badge tone={verified ? "positive" : "accent"} icon={verified ? "check-circle" : "clock"}>
            {t(verified ? "badgeDone" : "badgeWorking")}
          </Badge>
          <h3 id="customer-connection-title">{t(verified ? "titleDone" : "titleWorking")}</h3>
          <p>{t(verified ? "bodyDone" : "bodyWorking")}</p>
        </div>
        <ConnectionGraphic verified={verified} readOnly={t("readOnly")} />
      </div>
      <div className="progress-card-foot">
        <span>
          <Icon name={verified ? "check-circle" : "shield"} size={20} /> {t(verified ? "footDone" : "footWorking")}
        </span>
        {verified ? (
          <Link href="/onboarding/prepare" className="btn btn-secondary">
            {t("next")} <Icon name="arrow-right" size={16} />
          </Link>
        ) : (
          <small>{t("auto")}</small>
        )}
      </div>
    </section>
  );
}

export function PrepareStory({ state, t }: { state: "done" | "waiting" | "working"; t: T }) {
  const ready = state === "done";
  const waiting = state === "waiting";
  const statusIcon = ready ? "check-circle" : waiting ? "message-square" : "clock";
  return (
    <section className="stage-panel customer-data-card" aria-labelledby="customer-data-title">
      <div className={`connection-story customer-progress-story ${ready ? "is-ready" : ""}`}>
        <div className="connection-copy">
          <Badge tone={ready ? "positive" : waiting ? "attention" : "accent"} icon={statusIcon}>
            {t(ready ? "badgeDone" : waiting ? "badgeWaiting" : "badgeWorking")}
          </Badge>
          <h3 id="customer-data-title">{t(ready ? "titleDone" : waiting ? "titleWaiting" : "titleWorking")}</h3>
          <p>{t(ready ? "bodyDone" : waiting ? "bodyWaiting" : "bodyWorking")}</p>
        </div>
        <div className="preparation-graphic" aria-hidden="true">
          <svg viewBox="0 0 300 170" preserveAspectRatio="none" fill="none">
            <path d="M52 84H106C133 84 130 49 158 49H203M106 84C133 84 130 111 158 111H203" />
            <circle cx="106" cy="84" r="5" />
            <circle cx="160" cy="49" r="4" />
            <circle cx="160" cy="111" r="4" />
          </svg>
          <span className="preparation-source">
            <Icon name="database" size={26} />
          </span>
          <span className="preparation-lane lane-top">
            <Icon name="table" size={19} />
            <span>
              <i />
              <i />
            </span>
          </span>
          <span className="preparation-lane lane-bottom">
            <Icon name={ready ? "check-circle" : "layers"} size={19} />
            <span>
              <i />
              <i />
            </span>
          </span>
          <span className="preparation-caption">
            <Icon name={statusIcon} size={13} />
            {t(ready ? "captionDone" : waiting ? "captionWaiting" : "captionWorking")}
          </span>
        </div>
      </div>
      <div className="progress-card-foot">
        <span>
          <Icon name="check-circle" size={20} /> {t("connected")}
        </span>
        {ready ? (
          <Link href="/onboarding/org" className="btn btn-secondary">
            <Icon name="arrow-right" size={17} />
            <span>{t("next")}</span>
          </Link>
        ) : waiting ? (
          <small>{t("seeQuestion")}</small>
        ) : (
          <small>{t("auto")}</small>
        )}
      </div>
    </section>
  );
}

export function MetricsStatus({
  ready,
  t,
  byRole,
}: {
  ready: boolean;
  t: T;
  byRole: { role: string; measures: string[] }[];
}) {
  return (
    <section className="stage-panel metric-status-card">
      <div className="metric-status-copy">
        <Badge tone={ready ? "positive" : "accent"} icon={ready ? "check" : "clock"}>
          {t(ready ? "badgeDone" : "badgeWorking")}
        </Badge>
        <h3>{t(ready ? "titleDone" : "titleWorking")}</h3>
        <p>{t(ready ? "bodyDone" : "bodyWorking")}</p>
      </div>
      <div className="metric-status-graphic" aria-hidden="true">
        <div className="metric-status-chart">
          <span className="metric-status-label">
            <Icon name="chart-bar" size={17} />
            <i />
          </span>
          <span className="metric-status-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
        </div>
        <span className={`metric-status-mark${ready ? " is-ready" : ""}`}>
          <Icon name={ready ? "check" : "clock"} size={18} />
        </span>
      </div>
      {byRole.length > 0 && (
        <div className="metric-published">
          <h4>{t("byRole")}</h4>
          <dl>
            {byRole.map((r) => (
              <div key={r.role}>
                <dt>{r.role}</dt>
                <dd>
                  {r.measures.map((m) => (
                    <span key={m} className="metric-chip">
                      {m}
                    </span>
                  ))}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}
    </section>
  );
}

export function CheckinCard({ checkin, locale, t }: { checkin: Checkin; locale: string; t: T }) {
  const when = new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: checkin.timezone,
    timeZoneName: "short",
  }).format(new Date(checkin.at));
  const initials = checkin.lead
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  return (
    <section className="rail-card contact-card">
      <div className="contact-label">
        <Icon name="calendar" size={17} />
        <span className="eyebrow">{t("eyebrow")}</span>
      </div>
      <h2>{t("title")}</h2>
      <p>{when}</p>
      {checkin.note && <p>{checkin.note}</p>}
      {checkin.lead && (
        <div className="contact-person">
          <span className="avatar avatar-formada" aria-hidden="true">
            {initials}
          </span>
          <span>
            <strong>{checkin.lead}</strong>
            <small>{t("with")}</small>
          </span>
        </div>
      )}
    </section>
  );
}
