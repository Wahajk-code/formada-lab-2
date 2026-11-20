"use client";

import { useState } from "react";

import { cn } from "@/lib/utils";

const W = 240;
const H = 44;

export type SparkPoint = { label: string; value: number; display: string };

/** Single-series trend: 2px line, ~10% area wash, end dot; hover shows the point's value. */
export function Sparkline({
  points,
  inverted = false,
}: {
  points: SparkPoint[];
  inverted?: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map((p) => p.value);
  const lo = Math.min(...values, 0);
  const hi = Math.max(...values, 1);
  const x = (i: number) => 4 + (i / (points.length - 1)) * (W - 8);
  const y = (v: number) => 4 + (1 - (v - lo) / (hi - lo || 1)) * (H - 8);
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const last = points.length - 1;
  const shown = hover ?? last;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className={cn("h-11 w-full overflow-visible", inverted ? "text-background" : "text-foreground")}
        onPointerLeave={() => setHover(null)}
        role="img"
        aria-label={points.map((p) => `${p.label}: ${p.display}`).join(", ")}
      >
        <path d={`${line} L${x(last)},${H} L${x(0)},${H} Z`} fill="currentColor" opacity={0.1} />
        <path d={line} fill="none" stroke="currentColor" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {hover !== null && (
          <line x1={x(hover)} x2={x(hover)} y1={0} y2={H} stroke="currentColor" strokeOpacity={0.25} strokeWidth={1} />
        )}
        <circle
          cx={x(shown)}
          cy={y(points[shown].value)}
          r={4}
          fill="currentColor"
          stroke={inverted ? "var(--foreground)" : "var(--card)"}
          strokeWidth={2}
        />
        {points.map((p, i) => (
          <rect
            key={p.label}
            x={x(i) - W / points.length / 2}
            y={0}
            width={W / points.length}
            height={H}
            fill="transparent"
            onPointerEnter={() => setHover(i)}
          />
        ))}
      </svg>
      <p className={cn("mt-1 flex justify-between text-[11px] tabular-nums", inverted ? "text-background/70" : "text-muted-foreground")}>
        <span>{points[shown].label}</span>
        <span className={inverted ? "text-background" : "text-foreground"}>{points[shown].display}</span>
      </p>
    </div>
  );
}
