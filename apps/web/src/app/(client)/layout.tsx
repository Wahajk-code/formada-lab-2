import { cookies } from "next/headers";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { signOut } from "@/app/actions";
import { LocaleSwitch } from "@/components/locale-switch";
import { Logo } from "@/components/logo";
import { Breadcrumb } from "@/components/shell/breadcrumb";
import { MobileNav } from "@/components/shell/mobile-nav";
import { Nav } from "@/components/shell/nav";
import { SidebarFrame } from "@/components/shell/sidebar-frame";
import { NotificationsBell } from "@/components/shell/notifications-bell";
import { Icon } from "@/components/ui/icon";
import { api } from "@/lib/client-api";

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
}

/** Client app shell (Formada.AI design). Before go-live: the setup shell, a topbar and no
 * sidebar. Once live: a white sidebar (workspace, three nav groups, profile) and a topbar with
 * the breadcrumb, the AI brief and the bell. */
export default async function AppLayout({ children }: LayoutProps<"/">) {
  const [me, t, notes, jar] = await Promise.all([api.me(), getTranslations("nav"), api.notifications(), cookies()]);
  const collapsed = jar.get("formada.sidebar")?.value === "1";
  const live = me.tenant.lifecycle !== "onboarding";
  const isAdmin = me.app_role === "admin" || me.app_role === "owner";
  const roleLine = me.roles.map((r) => r.title).join(", ") || t("adminOnly");
  const labels = Object.fromEntries(
    [
      ["/dashboard", "dashboard"],
      ["/initiatives", "initiatives"],
      ["/archive", "archive"],
      ["/ledger", "ledger"],
      ["/org", "org"],
      ["/people", "people"],
      ["/runs", "runs"],
      ["/help", "help"],
      ["/settings", "settings"],
      ["/account", "account"],
      ["/onboarding", "onboarding"],
    ].map(([href, key]) => [href, t(key)]),
  );

  const profile = (
    <div className="grid gap-3">
      <Link
        href="/account"
        className="sb-card flex w-full min-w-0 items-center gap-[9px] rounded-[14px] border border-border bg-card p-2 text-left transition-colors hover:bg-surface"
        title={t("account")}
      >
        <span className="grid size-[37px] shrink-0 place-items-center rounded-full bg-soft-violet text-[13px] font-extrabold text-[#5938a6]">
          {initials(me.name)}
        </span>
        <span className="sb-label min-w-0 flex-1">
          <strong className="block truncate text-[13.5px] font-extrabold">{me.name}</strong>
          <small className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">{roleLine}</small>
        </span>
        <Icon name="chevrons-up-down" size={16} className="sb-label text-muted-foreground" />
      </Link>
      <div className="sb-label flex items-center justify-between gap-2 px-1">
        <LocaleSwitch />
        <form action={signOut}>
          <button
            type="submit"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-xs font-bold text-muted-foreground hover:bg-surface hover:text-foreground"
          >
            <Icon name="log-out" size={15} /> {t("signOut")}
          </button>
        </form>
      </div>
    </div>
  );

  if (!live) {
    // Setup shell: brand, workspace caption, help, settings, bell. No sidebar until go-live.
    return (
      <div className="min-h-screen bg-background">
        <header className="sticky top-0 z-30 grid min-h-[74px] grid-cols-[1fr_auto_1fr] items-center gap-5 border-b border-border bg-card px-[30px] max-md:min-h-[62px] max-md:px-3">
          <div className="flex items-center gap-4">
            <Link href="/onboarding" aria-label="Formada.AI">
              <Logo />
            </Link>
          </div>
          <span className="justify-self-center text-sm font-semibold whitespace-nowrap text-muted-foreground max-sm:hidden">
            {me.tenant.name}
          </span>
          <div className="flex items-center justify-end gap-[9px]">
            <Link href="/help" aria-label={t("help")} title={t("help")} className="grid size-11 place-items-center rounded-xl border border-border bg-card hover:bg-soft-violet max-sm:hidden">
              <Icon name="circle-help" size={19} />
            </Link>
            {isAdmin && (
              <Link href="/settings" aria-label={t("settings")} title={t("settings")} className="grid size-11 place-items-center rounded-xl border border-border bg-card hover:bg-soft-violet max-sm:hidden">
                <Icon name="settings" size={19} />
              </Link>
            )}
            <NotificationsBell data={notes} />
            <Link
              href="/account"
              title={me.name}
              className="grid size-10 place-items-center rounded-full bg-soft-violet text-[13px] font-extrabold text-[#5938a6]"
            >
              {initials(me.name)}
            </Link>
          </div>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-[1260px] px-[30px] pt-[33px] pb-11 max-md:px-3 max-md:pt-6">
          {children}
        </main>
      </div>
    );
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="sb-logo flex items-center justify-between px-2.5">
        <Link href="/dashboard" aria-label="Formada.AI">
          <span className="sb-full">
            <Logo />
          </span>
          <span className="sb-mini">
            <Logo withName={false} />
          </span>
        </Link>
      </div>
      <div className="sb-card mt-8 flex min-w-0 items-center gap-2.5 rounded-[14px] border border-border bg-surface p-[9px]" title={me.tenant.name}>
        <span className="grid size-[34px] shrink-0 place-items-center rounded-[10px] bg-ink text-base font-extrabold text-white">
          {me.tenant.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="sb-label min-w-0">
          <strong className="block truncate text-[13.5px] font-extrabold">{me.tenant.name}</strong>
          <small className="mt-0.5 block text-[11.5px] text-muted-foreground">{t("clientWorkspace")}</small>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <Nav isAdmin={isAdmin} />
      </div>
      <div className="pt-6">{profile}</div>
    </div>
  );

  return (
    <SidebarFrame sidebar={sidebar} defaultCollapsed={collapsed} label={t("collapse")}>
        <header className="sticky top-0 z-30 grid min-h-[74px] grid-cols-[1fr_auto_1fr] items-center gap-5 border-b border-border bg-card px-[30px] max-md:min-h-[62px] max-md:gap-2 max-md:px-3">
          <div className="flex items-center gap-2">
            <MobileNav>{sidebar}</MobileNav>
            <Breadcrumb root={t("breadcrumbRoot")} labels={labels} />
          </div>
          <Link
            href="/dashboard#brief"
            className="flex min-h-[42px] max-w-full items-center gap-[9px] rounded-full border border-ink bg-ink py-[5px] pr-[11px] pl-1.5 whitespace-nowrap text-white hover:bg-[#302940]"
          >
            <span className="grid size-[27px] shrink-0 place-items-center rounded-full bg-iris">
              <Icon name="sparkles" size={14} />
            </span>
            <span className="text-xs font-extrabold">{t("aiBrief")}</span>
            <span className="overflow-hidden border-l border-[#555260] pl-[9px] text-xs text-ellipsis text-[#e5e1ea] max-lg:hidden">
              {t("aiBriefSummary")}
            </span>
            <Icon name="arrow-up-right" size={14} className="text-[#ddd4ef] max-sm:hidden" />
          </Link>
          <div className="flex items-center justify-end gap-[9px]">
            <NotificationsBell data={notes} />
          </div>
        </header>
        <main id="main-content" className="mx-auto w-full max-w-[1550px] flex-1 px-[30px] pt-[33px] pb-11 max-md:px-3 max-md:pt-6">
          <div className="dw-page">{children}</div>
        </main>
    </SidebarFrame>
  );
}
