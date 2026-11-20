"use client";

import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState, useTransition } from "react";

import { markNotificationsRead } from "@/app/onboarding-actions";
import { Icon } from "@/components/ui/icon";
import type { Notifications } from "@/lib/client-api";
import { cn } from "@/lib/utils";

function ago(iso: string, locale: string) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (minutes < 1) return rtf.format(0, "minute");
  if (minutes < 60) return rtf.format(-minutes, "minute");
  if (minutes < 1440) return rtf.format(-Math.floor(minutes / 60), "hour");
  if (minutes < 10080) return rtf.format(-Math.floor(minutes / 1440), "day");
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(iso));
}

const KIND_ICON: Record<string, string> = {
  question: "message-circle",
  reply: "message-circle",
  step: "check",
  approved: "check",
  live: "rocket",
  run: "activity",
};

/** The bell and its panel (the design's notifications popover). Replaces the Notifications page. */
export function NotificationsBell({ data }: { data: Notifications }) {
  const t = useTranslations("notifications");
  const locale = useLocale();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const [, start] = useTransition();
  const anchor = useRef<HTMLDivElement>(null);
  const unread = data.items.filter((n) => !n.read);
  const visible = filter === "unread" ? unread : data.items;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (anchor.current && !anchor.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const openItem = (id: string, link: string) =>
    start(async () => {
      await markNotificationsRead([id]);
      setOpen(false);
      if (link) router.push(link);
      else router.refresh();
    });

  return (
    <div ref={anchor} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-label={unread.length ? t("bellUnread", { n: unread.length }) : t("bell")}
        title={t("bell")}
        className={cn(
          "relative grid size-10 place-items-center rounded-[10px] border border-border bg-card transition-colors hover:bg-soft-violet",
          open && "bg-surface-strong",
        )}
      >
        <Icon name="bell" size={20} />
        {unread.length > 0 && (
          <span className="absolute top-[7px] right-2 size-[7px] rounded-full border border-card bg-iris" />
        )}
      </button>
      {open && (
        <section
          aria-label={t("title")}
          className="node-pop absolute top-[calc(100%+12px)] right-0 z-40 grid max-h-[min(640px,calc(100dvh-96px))] w-[min(440px,calc(100vw-28px))] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-3xl border border-border bg-card shadow-pop"
        >
          <header className="flex min-h-[63px] items-center justify-between gap-3 border-b border-border px-5 py-3">
            <h2 className="text-[19px] font-bold tracking-[-0.03em]">{t("title")}</h2>
            <div className="flex gap-0.5" role="group">
              {(["all", "unread"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  aria-pressed={filter === f}
                  onClick={() => setFilter(f)}
                  className={cn(
                    "min-h-11 rounded-[10px] px-3 text-[13px] font-semibold text-muted-foreground hover:bg-surface-strong hover:text-foreground",
                    filter === f && "bg-surface-strong text-foreground",
                  )}
                >
                  {t(f)}
                </button>
              ))}
            </div>
          </header>
          <div className="min-h-0 overflow-y-auto overscroll-contain">
            {visible.length ? (
              <ul>
                {visible.map((n) => (
                  <li key={n.id} className="border-b border-border last:border-0">
                    <button
                      type="button"
                      onClick={() => openItem(n.id, n.link)}
                      className="grid min-h-[82px] w-full grid-cols-[auto_minmax(0,1fr)_7px] items-start gap-3 px-5 py-4 text-left hover:bg-surface"
                    >
                      <span className="relative grid size-[43px] place-items-center rounded-full bg-surface-strong">
                        <Icon name={KIND_ICON[n.kind] ?? "bell"} size={21} />
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="flex flex-wrap items-baseline gap-x-2 text-xs text-muted-foreground">
                          <span className="font-bold text-foreground">{t("from")}</span>
                          <time dateTime={n.at}>{ago(n.at, locale)}</time>
                        </span>
                        <strong className="text-sm leading-snug font-bold">{n.title}</strong>
                        <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{n.body}</span>
                      </span>
                      {!n.read && <span className="mt-1.5 size-[7px] rounded-full bg-iris" aria-label={t("unread")} />}
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="grid justify-items-center gap-1.5 px-4 py-8 text-center text-sm">
                <span className="mb-0.5 grid size-[42px] place-items-center rounded-2xl bg-surface-strong text-muted-foreground">
                  <Icon name="bell" size={21} />
                </span>
                <strong>{filter === "unread" ? t("emptyUnread") : t("emptyAll")}</strong>
                <p className="text-[13px] text-muted-foreground">{filter === "unread" ? t("caughtUp") : t("updatesHere")}</p>
              </div>
            )}
          </div>
          {data.items.length > 0 && (
            <footer className="flex min-h-12 items-center justify-between gap-2.5 border-t border-border px-5 text-xs text-muted-foreground">
              <span>{unread.length ? t("unreadCount", { n: unread.length }) : t("allCaughtUp")}</span>
              {unread.length > 0 && (
                <button
                  type="button"
                  onClick={() => start(async () => { await markNotificationsRead(); router.refresh(); })}
                  className="inline-flex min-h-11 items-center gap-1.5 text-xs font-bold text-iris hover:text-iris-ink"
                >
                  <Icon name="check" size={15} /> {t("markAll")}
                </button>
              )}
            </footer>
          )}
        </section>
      )}
    </div>
  );
}
