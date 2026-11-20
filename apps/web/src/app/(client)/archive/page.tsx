import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { LazyCard } from "@/components/cards/lazy-card";
import { FilterSelect } from "@/components/ui/filter-select";
import { Icon } from "@/components/ui/icon";
import { LazyDetails } from "@/components/ui/lazy-details";
import { PageHeader } from "@/components/ui/page-header";
import { SearchBox } from "@/components/ui/search-box";
import { api, type CardStatus, type LedgerInitiative } from "@/lib/client-api";
import { fullDay } from "@/lib/format";
import { requireLive } from "@/lib/lifecycle-gate";

const DAY = 86_400_000;
const ARCHIVE_AFTER_DAYS = 90;
const CLOSED: CardStatus[] = ["actioned", "not_relevant", "impossible", "expired"];
const since = (days: number) => (days ? Date.now() - days * DAY : 0);
const now = () => Date.now();

type Search = Promise<{ tab?: string; q?: string; role?: string; period?: string; status?: string }>;

/** When an initiative reached the archive: 90 days after its review (or when tracking stopped), unless
 * it was marked Keep doing, which keeps it in tracking. */
function archivedAt(i: LedgerInitiative): number | null {
  if (i.status === "cancelled") return Date.parse(i.ends_on);
  const reviewed = (i.end ?? i.midpoint)?.measured_at;
  if (i.status !== "done" || i.keep_or_stop === "keep" || !reviewed) return null;
  const at = Date.parse(reviewed) + ARCHIVE_AFTER_DAYS * DAY;
  return at <= now() ? at : null;
}

function outcome(i: LedgerInitiative) {
  const v = (i.end ?? i.midpoint)?.value_captured ?? 0;
  return v > 0 ? "improved" : v < 0 ? "worsened" : "unchanged";
}

/** Archive (Formada.AI design): past initiatives and closed insight cards in the person's scope. */
export default async function ArchivePage({ searchParams }: { searchParams: Search }) {
  await requireLive();
  const { tab, q, role, period, status } = await searchParams;
  const cards = tab === "cards";
  const days = period === "30" || period === "90" || period === "365" ? Number(period) : 0;
  const needle = (q ?? "").toLowerCase();
  const [me, ledger, h, t, th, locale] = await Promise.all([
    api.me(),
    api.ledger(),
    api.history({}),
    getTranslations("archive"),
    getTranslations("historyPage"),
    getLocale(),
  ]);
  const cutoff = since(days);
  const validStatus = CLOSED.includes(status as CardStatus) ? (status as CardStatus) : undefined;

  const initiatives = ledger.initiatives
    .map((i) => ({ i, at: archivedAt(i) }))
    .filter((x): x is { i: LedgerInitiative; at: number } => x.at != null)
    .filter(({ i }) => !role || i.role === role)
    .filter(({ at }) => at >= cutoff)
    .filter(({ i }) => !needle || `${i.card.title} ${i.role} ${i.owner} ${i.metric}`.toLowerCase().includes(needle))
    .sort((a, b) => b.at - a.at);
  const closed = h.cards
    .filter((c) => CLOSED.includes(c.status))
    .filter((c) => !role || c.role === role)
    .filter((c) => !validStatus || c.status === validStatus)
    .filter((c) => Date.parse(c.created_at) >= cutoff)
    .filter((c) => !needle || `${c.title} ${c.role}`.toLowerCase().includes(needle));
  const roles = [...new Set((cards ? h.cards.map((c) => c.role) : ledger.initiatives.map((i) => i.role)))].sort();
  const count = cards ? closed.length : initiatives.length;
  const tabHref = (k: "initiatives" | "cards") => (k === "cards" ? "/archive?tab=cards" : "/archive");

  return (
    <>
      <PageHeader role={me.roles[0]?.title} title={t("title")} subtitle={t("subtitle")} />
      <section className="arc-panel">
        <div className="arc-head">
          <div>
            <h2>{cards ? t("archivedCards") : t("archivedInitiatives")}</h2>
            <p>{t("results", { n: count })}</p>
          </div>
          <nav className="arc-tabs" aria-label={t("title")}>
            <Link href={tabHref("initiatives")} aria-current={cards ? undefined : "page"}>
              {t("tabInitiatives")}
            </Link>
            <Link href={tabHref("cards")} aria-current={cards ? "page" : undefined}>
              {t("tabCards")}
            </Link>
          </nav>
        </div>
        <div className={cards ? "arc-filters arc-filters-4" : "arc-filters"} key={tab ?? "initiatives"}>
          <SearchBox label={t("searchLabel")} placeholder={t("searchPlaceholder")} />
          <FilterSelect param="role" label={t("sourceRole")} value={role ?? ""} options={[["", t("allVisibleRoles")], ...roles.map((r): [string, string] => [r, r])]} />
          <FilterSelect
            param="period"
            label={cards ? t("closed") : t("archived")}
            value={days ? String(days) : ""}
            options={[["", t("anyTime")], ["30", t("last30")], ["90", t("last90")], ["365", t("lastYear")]]}
          />
          {cards && (
            <FilterSelect
              param="status"
              label={t("status")}
              value={validStatus ?? ""}
              options={[["", t("allStatuses")], ...CLOSED.map((s): [string, string] => [s, th(`statuses.${s}`)])]}
            />
          )}
        </div>

        {count ? (
          <div className="dw-records dw-stagger">
            {cards
              ? closed.map((c) => (
                  <LazyDetails
                    key={c.id}
                    className="dw-record"
                    summary={
                      <>
                        <span className="dw-symbol">
                          <Icon name="layers" size={19} />
                        </span>
                        <span className="dw-record-title">
                          <strong>{c.title}</strong>
                          <small>
                            {c.role} · {fullDay(c.created_at, locale)}
                          </small>
                        </span>
                        <span className={`ini-pill ${c.status === "actioned" ? "ini-pill-improved" : "ini-pill-unchanged"}`}>{th(`statuses.${c.status}`)}</span>
                        <Icon name="chevron-down" size={18} className="ini-chevron" />
                      </>
                    }
                  >
                    <div className="dw-record-body">
                      {c.feedback && (
                        <p className="dw-quiet">
                          {th("feedback")} · {c.feedback.by}
                          {c.feedback.reason ? `: “${c.feedback.reason}”` : ""}
                        </p>
                      )}
                      <LazyCard id={c.id} roleTitle={c.role} department={c.department} />
                    </div>
                  </LazyDetails>
                ))
              : initiatives.map(({ i, at }) => (
                  <LazyDetails
                    key={i.id}
                    className="dw-record"
                    summary={
                      <>
                        <span className="dw-record-title">
                          <strong>{i.card.title}</strong>
                          <small>
                            {i.role} · {i.owner}
                          </small>
                        </span>
                        <span className="ini-side">
                          <span className={`ini-pill ini-pill-${outcome(i)}`}>{t(`outcome.${outcome(i)}`)}</span>
                          <small>{t("archivedOn", { date: fullDay(new Date(at).toISOString(), locale) })}</small>
                        </span>
                        <Icon name="chevron-down" size={18} className="ini-chevron" />
                      </>
                    }
                  >
                    <div className="dw-record-body">
                      <LazyCard id={i.card.id} roleTitle={i.role} department={i.department} />
                    </div>
                  </LazyDetails>
                ))}
          </div>
        ) : (
          <section className="dw-empty">
            <span className="dw-symbol">
              <Icon name="layers" size={23} />
            </span>
            <h2>{t("noResults")}</h2>
            <p>{t("noResultsBody")}</p>
          </section>
        )}

        <aside className="arc-retention">
          <h3>{t("retentionTitle")}</h3>
          <p>{t("retentionBody", { n: ARCHIVE_AFTER_DAYS })}</p>
        </aside>
      </section>
    </>
  );
}
