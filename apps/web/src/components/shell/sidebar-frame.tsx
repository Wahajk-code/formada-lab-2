"use client";

import { PanelLeftClose } from "lucide-react";
import { useState } from "react";

/** The app frame with a collapsible sidebar. The choice lives in a cookie, so the server renders the
 * right width on the first paint. */
export function SidebarFrame({
  sidebar,
  children,
  defaultCollapsed,
  label,
}: {
  sidebar: React.ReactNode;
  children: React.ReactNode;
  defaultCollapsed: boolean;
  label: string;
}) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    document.cookie = `formada.sidebar=${next ? "1" : "0"}; path=/; max-age=31536000; samesite=lax`;
  };
  return (
    <div className="sb-frame min-h-screen" data-collapsed={collapsed}>
      <aside className="sb-aside hidden lg:block" aria-label={label}>
        <button type="button" className="sb-toggle" onClick={toggle} aria-pressed={collapsed} aria-label={label} title={label}>
          <PanelLeftClose size={15} />
        </button>
        <div className="sb-scroll">{sidebar}</div>
      </aside>
      <div className="flex min-w-0 flex-col">{children}</div>
    </div>
  );
}
