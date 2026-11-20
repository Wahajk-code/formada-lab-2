import { getTranslations } from "next-intl/server";

import { NavLink } from "@/components/nav-link";
import { Icon } from "@/components/ui/icon";

export type NavItem = { href: string; key: string; icon: string; group: "workspace" | "manage" | "resources"; admin?: boolean };

/** The live workspace navigation (Formada.AI design, REDESIGN-PLAN decision 7). */
export function navItems(isAdmin: boolean): NavItem[] {
  const items: NavItem[] = [
    { href: "/dashboard", key: "dashboard", icon: "layout-dashboard", group: "workspace" },
    { href: "/initiatives", key: "initiatives", icon: "target", group: "workspace" },
    { href: "/ledger", key: "ledger", icon: "chart-bar", group: "workspace" },
    { href: "/org", key: "org", icon: "network", group: "manage" },
    { href: "/people", key: "people", icon: "users", group: "manage", admin: true },
    { href: "/runs", key: "runs", icon: "activity", group: "manage" },
    { href: "/archive", key: "archive", icon: "layers", group: "resources" },
    { href: "/help", key: "help", icon: "circle-help", group: "resources" },
    { href: "/settings", key: "settings", icon: "settings", group: "resources" },
  ];
  return items.filter((i) => isAdmin || !i.admin);
}

/** Sidebar navigation in three groups. Rendered on the server; links highlight on the client. */
export async function Nav({ isAdmin, onNavigate }: { isAdmin: boolean; onNavigate?: () => void }) {
  const t = await getTranslations("nav");
  const items = navItems(isAdmin);
  const groups = (["workspace", "manage", "resources"] as const).filter((g) => items.some((i) => i.group === g));
  return (
    <nav className="mt-6" aria-label={t("main")}>
      {groups.map((g, i) => (
        <div key={g} className={i ? "mt-6" : undefined}>
          <p className="eyebrow sb-eyebrow mb-[7px] ml-[11px]">{t(`group.${g}`)}</p>
          {items
            .filter((x) => x.group === g)
            .map((x) => (
              <NavLink key={x.href} href={x.href} icon={<Icon name={x.icon} size={19} />} onNavigate={onNavigate}>
                {t(x.key)}
              </NavLink>
            ))}
        </div>
      ))}
    </nav>
  );
}
