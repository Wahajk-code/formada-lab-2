import { Ban, CircleCheck, CircleDashed, CircleDot, CircleX, Clock, Hourglass, TriangleAlert } from "lucide-react";
import { getTranslations } from "next-intl/server";

import { cn } from "@/lib/utils";

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  open: CircleDot,
  actioned: CircleCheck,
  not_relevant: CircleDashed,
  impossible: Ban,
  expired: Hourglass,
  in_progress: Clock,
  done: CircleCheck,
  cancelled: CircleX,
  running: Clock,
  succeeded: CircleCheck,
  partial: TriangleAlert,
  failed: CircleX,
  proposed: CircleDot,
  active: CircleCheck,
  retired: Hourglass,
  rejected: CircleX,
};

/** State pill: icon + label, never colour alone. Solid ink for states that need attention. */
export async function Status({ value, className }: { value: string; className?: string }) {
  const t = await getTranslations("status");
  const Icon = ICONS[value] ?? CircleDot;
  const strong = ["open", "failed", "partial", "proposed", "running"].includes(value);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium",
        strong ? "bg-foreground text-background" : "bg-surface-strong text-foreground/80",
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />
      {t.has(value) ? t(value) : value.replaceAll("_", " ")}
    </span>
  );
}
