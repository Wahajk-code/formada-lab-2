import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { InsightCard } from "@/components/cards/insight-card";
import { ExecutiveView, type ExecutiveSearch } from "@/components/dashboard/executive/executive-view";
import { RolePicker } from "@/components/cards/role-picker";
import { Icon } from "@/components/ui/icon";
import { api } from "@/lib/client-api";
import { roundMoney } from "@/lib/format";
import { requireLive } from "@/lib/lifecycle-gate";
import { viewLevel } from "@/lib/views/level";

type Scope = "own" | "team" | "all";

/** Insights overview (Formada.AI design): the decision queue, a summary and the insight feed,
 * for the active role. Cards live here now; the separate Cards page is gone (ADR 0030). */
export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ role?: string; scope?: string; view?: string } & ExecutiveSearch> }) {
  await requireLive();
  const [{ role: roleParam, scope: rawScope, view, ...exec }, me, org, dash, t, locale] = await Promise.all([
    searchParams,
    api.me(),
    api.org(),
    api.dashboard(),
    getTranslations("dash"),
    getLocale(),
  ]);
  const byId = new Map(org.roles.map((r) => [r.id, r]));
  const depts = new Map(org.departments.map((d) => [d.id, d.name]));
  const roleId = (roleParam && byId.has(roleParam) && roleParam) || me.roles[0]?.id || null;
  // The view depends on the level of the active role (see lib/views/level.ts). Upper management and
  // workspace admins without a role of their own get the executive overview; the other levels keep the
  // role dashboard until their views are designed.
  const level = viewLevel(roleId, org.roles);
  const admin = me.app_role === "owner" || me.app_role === "admin";
  if (view === "executive" || level === "upper" || (!roleId && admin)) return <ExecutiveView search={exec} />;
  const scope: Scope = rawScope === "team" || rawScope === "all" ? rawScope : "own";
  const header = (
    <header className="dw-page-head">
      <div>
        <p className="eyebrow dw-overline">{me.tenant.name}</p>
        <h1>{t("title")}</h1>
        <p>{t("subtitle")}</p>
      </div>
      {roleId && (
        <RolePicker
          roles={org.roles.map((r) => ({ id: r.id, title: r.title, open: r.open_cards }))}
          current={roleId}
          label={t("activeRole")}
          fallback={me.roles[0]?.id ?? ""}
        />
      )}
    </header>
  );

  if (!roleId) {
    return (
      <>
        {header}
        <section className="dw-empty">
          <span className="dw-symbol">
            <Icon name="users" size={23} />
          </span>
          <h2>{t("noRole")}</h2>
          <p>{t("noRoleBody")}</p>
          <Link href="/org" className="btn btn-secondary">
            <Icon name="arrow-right" size={17} />
            <span>{t("openOrg")}</span>
          </Link>
        </section>
      </>
    );
  }

  const data = await api.roleCards(roleId);
  const mine = me.roles.find((r) => r.id === roleId);
  const canAct = mine?.permission === "owner";
  const own = data.cards;
  const team = data.rollup;
  // Cards routed to this role (its own and its vacant reports', ADR 0005) can be actioned here.
  const ownIds = new Set(own.map((c) => c.id));
  const cards = (scope === "team" ? team : scope === "all" ? [...own, ...team] : own)
    .slice()
    .sort((a, b) => Number(b.expected_impact) - Number(a.expected_impact));
  const queue = canAct ? own.filter((c) => c.status === "open").length : 0;
  const link = (s: Scope) => `/dashboard?role=${roleId}&scope=${s}`;

  return (
    <>
      {header}
      <div className="dw-overview" id="brief">
        <div className="dw-priority">
          <div>
            <span className="dw-symbol">
              <Icon name="sparkles" size={19} />
            </span>
            <p className="eyebrow">{t("queue")}</p>
          </div>
          <strong>{queue}</strong>
          <h2>{t("queueTitle", { n: queue })}</h2>
          <p>{t("queueBody")}</p>
        </div>
        <div className="dw-summary">
          <div className="dw-stat">
            <div>
              <Icon name="network" size={17} />
              <span>{t("teamSignals")}</span>
            </div>
            <strong>{team.length}</strong>
            <p>{t("teamSignalsBody")}</p>
          </div>
          <div className="dw-stat">
            <div>
              <Icon name="target" size={17} />
              <span>{t("initiatives")}</span>
            </div>
            <strong>{dash.kpis.initiatives_in_progress}</strong>
            <p>{t("initiativesBody")}</p>
          </div>
          <div className="dw-stat">
            <div>
              <Icon name="chart-bar" size={17} />
              <span>{t("measured")}</span>
            </div>
            <strong>{roundMoney(dash.kpis.value_captured, dash.currency, locale)}</strong>
            <p>{t("measuredBody", { currency: dash.currency })}</p>
          </div>
        </div>
      </div>
      <section className="dw-feed">
        <div className="dw-section-head">
          <div>
            <h2>{t("feed")}</h2>
            <p>{t("feedBody")}</p>
          </div>
          <div className="dw-segments" role="group" aria-label={t("feed")}>
            {(
              [
                ["own", t("myRole"), own.length],
                ["team", t("teamInsights"), team.length],
                ["all", t("all"), own.length + team.length],
              ] as const
            ).map(([id, label, count]) => (
              <Link key={id} href={link(id)} aria-current={scope === id ? "page" : undefined} className="dw-segment-link">
                {label}
                <span>{count}</span>
              </Link>
            ))}
          </div>
        </div>
        {cards.length ? (
          <div className="dw-insight-grid">
            {cards.map((c) => {
              const r = byId.get(c.role_node_id);
              return (
                <InsightCard
                  key={c.id}
                  card={c}
                  roleTitle={r?.title ?? ""}
                  department={r?.department_id ? depts.get(r.department_id) : null}
                  canAct={canAct && ownIds.has(c.id)}
                  own={c.role_node_id === roleId}
                />
              );
            })}
          </div>
        ) : (
          <section className="dw-empty">
            <span className="dw-symbol">
              <Icon name="sparkles" size={23} />
            </span>
            <h2>{t("emptyTitle")}</h2>
            <p>{t("emptyBody")}</p>
          </section>
        )}
      </section>
    </>
  );
}
