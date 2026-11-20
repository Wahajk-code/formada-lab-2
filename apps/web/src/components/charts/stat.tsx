import { Sparkline, type SparkPoint } from "@/components/charts/sparkline";
import { cn } from "@/lib/utils";

/** Stat tile: label, value, optional context line and a 8-point trend. */
export function Stat({
  label,
  value,
  hint,
  trend,
  icon,
  delay = 0,
  hero = false,
}: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  trend?: SparkPoint[];
  icon?: React.ReactNode;
  delay?: number;
  hero?: boolean;
}) {
  return (
    <div
      className={cn(
        "animate-rise group relative overflow-hidden rounded-2xl bg-card p-4 shadow-card transition-all duration-300 hover:-translate-y-0.5 hover:shadow-card-hover sm:p-5",
        hero && "bg-foreground text-background",
      )}
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <p className={cn("text-xs font-medium", hero ? "text-background/70" : "text-muted-foreground")}>{label}</p>
        {icon && (
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full transition-transform duration-300 group-hover:rotate-6",
              hero ? "bg-background/10" : "bg-surface",
            )}
            aria-hidden
          >
            {icon}
          </span>
        )}
      </div>
      <p className="mt-2 text-[1.7rem] font-semibold leading-none tracking-tight tabular-nums">{value}</p>
      {hint && <p className={cn("mt-2 text-xs", hero ? "text-background/70" : "text-muted-foreground")}>{hint}</p>}
      {trend && trend.length > 1 && (
        <div className="mt-3">
          <Sparkline points={trend} inverted={hero} />
        </div>
      )}
    </div>
  );
}
