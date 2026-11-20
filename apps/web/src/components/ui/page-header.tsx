import { Users } from "lucide-react";
import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Icon } from "@/components/ui/icon";
import { RefreshButton } from "@/components/ui/refresh-button";

/** Page title block (Formada.AI design): title and subtitle on the left; on the right the active role
 * and a Refresh data button when given, then any extra actions. */
export async function PageHeader({
  title,
  subtitle,
  help,
  role,
  refresh = false,
  children,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  help?: string;
  role?: string;
  refresh?: boolean;
  children?: React.ReactNode;
}) {
  const [t, te] = await Promise.all([getTranslations("help"), getTranslations("exec")]);
  return (
    <header className="dw-page-head animate-rise flex-wrap">
      <div className="min-w-0">
        <h1 className="flex items-center gap-3">
          {title}
          {help && (
            <Link
              href={`/help?a=${help}`}
              title={t("aboutPage")}
              aria-label={t("aboutPage")}
              className="rounded-full p-1 text-muted-foreground transition-colors hover:bg-soft-violet hover:text-iris"
            >
              <Icon name="question-circle" size={20} />
            </Link>
          )}
        </h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {(role || refresh || children) && (
        <div className="flex flex-wrap items-center gap-2.5">
          {children}
          {role && (
            <div className="ex-chip">
              <Users size={19} aria-hidden="true" />
              <span>
                <small>{te("activeRole")}</small>
                {role}
              </span>
            </div>
          )}
          {refresh && <RefreshButton label={te("refresh")} />}
        </div>
      )}
    </header>
  );
}
