import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { changeMyPassword, signOutEverywhere } from "@/app/actions";
import { PasswordForm } from "@/components/account/password-form";
import { RuleReview } from "@/components/settings/rule-review";
import { RunNow } from "@/components/settings/run-now";
import { WorkspaceForm } from "@/components/settings/workspace-form";
import { Icon } from "@/components/ui/icon";
import { Status } from "@/components/ui/status";
import { api } from "@/lib/client-api";
import { dateTime, num } from "@/lib/format";

const ADMIN_TABS = ["workspace", "rules", "usage"] as const;
type Tab = "account" | (typeof ADMIN_TABS)[number];

function Meter({ label, used, cap, display }: { label: string; used: number; cap: number | null; display: string }) {
  const share = cap ? Math.min(1, used / cap) : 0;
  return (
    <div className="dw-stat">
      <div>
        <span>{label}</span>
      </div>
      <strong>{display}</strong>
      {cap !== null && (
        <div className="dw-driver-track" role="meter" aria-valuenow={used} aria-valuemax={cap}>
          <i style={{ width: `${Math.max(1, share * 100)}%` }} />
        </div>
      )}
    </div>
  );
}

/** Settings (Formada.AI design): the signed-in person's profile and password. Owners and admins
 *  also get the workspace, rule review and usage views here; detection rules and the AI model are
 *  set by the internal team in the console (ADR 0021). */
export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const me = await api.me();
  const admin = me.app_role !== "member";
  const { tab: raw } = await searchParams;
  const tab: Tab = admin && ADMIN_TABS.some((x) => x === raw) ? (raw as Tab) : "account";
  const [t, ta, tr, tp, tu, tw, locale] = await Promise.all([
    getTranslations("settings"),
    getTranslations("account"),
    getTranslations("reset"),
    getTranslations("people"),
    getTranslations("usage"),
    getTranslations("workflows"),
    getLocale(),
  ]);
  const initials = me.name
    .split(" ")
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

  let body: React.ReactNode;
  if (tab === "account") {
    body = (
      <>
        <div className="utility-card profile-card">
          <span className="profile-avatar">{initials}</span>
          <div>
            <h2>{me.name}</h2>
            <p>{me.email}</p>
          </div>
          <span className="tag">{tp(`role.${me.app_role}`)}</span>
        </div>
        <div className="utility-card settings-card">
          <h2>{t("changePassword")}</h2>
          <p className="screen-subtitle">{tr("rules")}</p>
          <PasswordForm
            onSave={changeMyPassword}
            labels={{ current: ta("current"), next: tr("newPassword"), confirm: tr("confirm"), save: t("savePassword"), saved: ta("saved"), mismatch: tr("mismatch"), rules: tr("rules") }}
          />
        </div>
        <div className="utility-card settings-card">
          <h2>{ta("sessions")}</h2>
          <p className="screen-subtitle">{ta("sessionsHint")}</p>
          <form action={signOutEverywhere} className="screen-form">
            <button type="submit" className="btn btn-secondary">
              <Icon name="log-out" size={16} /> {ta("signOutEverywhere")}
            </button>
          </form>
        </div>
      </>
    );
  } else if (tab === "workspace") {
    body = <WorkspaceForm workspace={(await api.people()).workspace} />;
  } else if (tab === "rules") {
    body = <RuleReview rules={(await api.rules()).rules} />;
  } else {
    const u = await api.usage();
    body = (
      <>
        <div className="dw-summary">
          <Meter label={tu("credits")} used={u.month.estimated_credits} cap={u.month.credit_cap} display={`${num(u.month.estimated_credits, locale, 3)} / ${u.month.credit_cap ?? "–"}`} />
          <Meter label={tu("tokens", { model: u.month.llm_model })} used={u.month.llm_tokens} cap={null} display={u.month.llm_tokens.toLocaleString(locale)} />
        </div>
        <p className="screen-subtitle">{tu("note", { runs: u.month.runs, seconds: num(u.month.query_seconds, locale) })}</p>
        <section className="dw-list-shell">
          <div className="dw-section-head">
            <h2>{tu("runs")}</h2>
            <RunNow />
          </div>
          <div className="dw-table-wrap" tabIndex={0} role="region" aria-label={tu("runs")}>
            <table className="dw-table">
              <thead>
                <tr>
                  {["type", "status", "started", "period"].map((h) => (
                    <th key={h} scope="col">
                      {tu(`col.${h}`)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {u.runs.map((r) => (
                  <tr key={r.id}>
                    <td>{tw(`runType.${r.type}`)}</td>
                    <td>
                      <Status value={r.status} />
                    </td>
                    <td className="dw-mono">{dateTime(r.started_at, locale)}</td>
                    <td className="dw-mono">{r.period_end}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </>
    );
  }

  return (
    <section className="utility-screen">
      <header className="utility-heading">
        <p className="eyebrow">{t("accountEyebrow")}</p>
        <h1>{t("title")}</h1>
        <p className="screen-subtitle">{t("accountSubtitle")}</p>
      </header>
      {admin && (
        <div className="dw-segments" role="group" aria-label={t("title")}>
          {(["account", ...ADMIN_TABS] as const).map((key) => (
            <Link key={key} href={key === "account" ? "/settings" : `/settings?tab=${key}`} aria-current={tab === key ? "page" : undefined} className="dw-segment-link">
              {key === "account" ? t("accountTab") : t(`tab.${key}`)}
            </Link>
          ))}
        </div>
      )}
      {body}
    </section>
  );
}
