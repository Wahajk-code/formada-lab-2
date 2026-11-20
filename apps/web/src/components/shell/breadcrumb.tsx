"use client";

import { usePathname } from "next/navigation";

import { Icon } from "@/components/ui/icon";

/** "Workspace › Current page" in the topbar. Labels come from the server (translated). */
export function Breadcrumb({ root, labels }: { root: string; labels: Record<string, string> }) {
  const path = usePathname();
  const key = Object.keys(labels)
    .sort((a, b) => b.length - a.length)
    .find((k) => path === k || path.startsWith(`${k}/`));
  return (
    <div className="flex items-center gap-2 text-[13px] whitespace-nowrap text-muted-foreground">
      <span className="max-md:hidden">{root}</span>
      <Icon name="chevron-right" size={14} className="max-md:hidden" />
      <strong className="font-bold text-foreground">{key ? labels[key] : root}</strong>
    </div>
  );
}
