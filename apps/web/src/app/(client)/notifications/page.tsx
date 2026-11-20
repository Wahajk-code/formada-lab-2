import { Bell } from "lucide-react";
import Link from "next/link";
import { getLocale, getTranslations } from "next-intl/server";

import { MarkAllRead } from "@/components/onboarding/mark-all-read";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/client-api";
import { cn } from "@/lib/utils";

export default async function NotificationsPage() {
  const [data, t, locale] = await Promise.all([
    api.notifications(),
    getTranslations("notifications"),
    getLocale(),
  ]);
  return (
    <div className="space-y-6">
      <PageHeader title={t("title")} subtitle={t("subtitle")}>
        {data.unread > 0 && <MarkAllRead label={t("markAll")} />}
      </PageHeader>
      {data.items.length === 0 ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Bell className="size-4" /> {t("empty")}
        </p>
      ) : (
        <ul className="space-y-2">
          {data.items.map((n, i) => (
            <li
              key={n.id}
              className={cn(
                "animate-rise flex items-start gap-3 rounded-2xl bg-card p-4 shadow-card",
                n.read && "opacity-70",
              )}
              style={{ animationDelay: `${Math.min(i, 8) * 40}ms` }}
            >
              <span
                className={cn(
                  "mt-1.5 size-2 shrink-0 rounded-full",
                  n.read ? "bg-surface-strong" : "bg-brand",
                )}
              />
              <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{n.title}</p>
                {n.body && (
                  <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
                    {n.body}
                  </p>
                )}
                <p className="mt-1 text-[11px] text-muted-foreground">
                  {new Date(n.at).toLocaleString(locale, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  })}
                </p>
              </div>
              {n.link && (
                <Link
                  href={n.link}
                  className="shrink-0 rounded-full px-3 py-1.5 text-xs font-medium hover:bg-surface"
                >
                  {t("open")} →
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
