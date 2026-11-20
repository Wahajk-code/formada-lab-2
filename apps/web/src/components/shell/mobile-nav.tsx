"use client";

import { Menu, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/** Phone and tablet: the sidebar slides in from the left. The nav itself is server-rendered
 *  and passed in as children, so links and labels stay identical to the desktop sidebar. */
export function MobileNav({ children, panelClassName }: { children: React.ReactNode; panelClassName?: string }) {
  const t = useTranslations("nav");
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setOpen(false); // close after navigating
  }

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [open]);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t("menu")}
        aria-expanded={open}
        className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-surface hover:text-foreground lg:hidden"
      >
        <Menu className="size-5" />
      </button>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-foreground/20 backdrop-blur-[2px] transition-opacity duration-300 lg:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
        onClick={() => setOpen(false)}
        aria-hidden
      />
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col bg-background px-3 py-4 shadow-card-hover transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] lg:hidden",
          open ? "translate-x-0" : "-translate-x-full",
          panelClassName,
        )}
        aria-hidden={!open}
        inert={!open}
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          aria-label={t("close")}
          className="absolute right-3 top-3 rounded-lg p-2 text-muted-foreground hover:bg-surface hover:text-foreground"
        >
          <X className="size-5" />
        </button>
        {children}
      </aside>
    </>
  );
}
