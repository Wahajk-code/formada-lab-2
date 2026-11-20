"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { cn } from "@/lib/utils";

/** A sidebar link in the Formada.AI style: 45px rows, soft-violet when current. */
export function NavLink({
  href,
  icon,
  children,
  badge,
  exact = false,
  onNavigate,
}: {
  href: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
  badge?: React.ReactNode;
  /** Highlight only on this exact path (for a section's home page). */
  exact?: boolean;
  onNavigate?: () => void;
}) {
  const path = usePathname();
  const active = path === href || (!exact && path.startsWith(`${href}/`));
  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? "page" : undefined}
      title={typeof children === "string" ? children : undefined}
      className={cn(
        "sb-row my-0.5 flex min-h-[45px] items-center gap-[11px] rounded-xl border px-[11px] text-sm font-bold transition-colors duration-150",
        active
          ? "border-[#e5dcfb] bg-soft-violet text-iris-ink"
          : "border-transparent text-muted-foreground hover:bg-surface hover:text-foreground",
      )}
    >
      <span className="flex shrink-0 items-center justify-center">{icon}</span>
      <span className="sb-label min-w-0 flex-1 truncate">{children}</span>
      {badge && <span className="sb-label">{badge}</span>}
    </Link>
  );
}
