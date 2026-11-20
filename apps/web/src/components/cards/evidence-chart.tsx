import type { Evidence } from "@/lib/client-api";

const W = 560;
const H = 140;
const PAD = { top: 12, right: 8, bottom: 18, left: 8 };

/** Weekly series vs the baseline (dashed), recent window shaded, threshold dotted. No colour:
 *  emphasis comes from weight and contrast. */
export function EvidenceChart({ evidence, recentWeeks = 3 }: { evidence: Evidence; recentWeeks?: number }) {
  const series = evidence.series;
  if (series.length < 2) return null;
  const values = series.map((p) => p.value);
  const extra = [evidence.baseline_mean, evidence.threshold ?? evidence.baseline_mean];
  const lo = Math.min(...values, ...extra);
  const hi = Math.max(...values, ...extra);
  const span = hi - lo || 1;
  const x = (i: number) => PAD.left + (i / (series.length - 1)) * (W - PAD.left - PAD.right);
  const y = (v: number) => PAD.top + (1 - (v - lo) / span) * (H - PAD.top - PAD.bottom);

  const line = series.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(" ");
  const area = `${line} L${x(series.length - 1)},${H - PAD.bottom} L${x(0)},${H - PAD.bottom} Z`;
  const recentStart = x(Math.max(0, series.length - recentWeeks));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={`${evidence.metric}, ${evidence.entity}`}>
      <defs>
        <linearGradient id="fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.12" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <rect
        x={recentStart - 6}
        y={PAD.top - 6}
        width={W - PAD.right - recentStart + 12}
        height={H - PAD.top - PAD.bottom + 12}
        rx="8"
        className="fill-foreground/[0.04]"
      />
      <line
        x1={PAD.left}
        x2={W - PAD.right}
        y1={y(evidence.baseline_mean)}
        y2={y(evidence.baseline_mean)}
        className="stroke-muted-foreground"
        strokeDasharray="4 4"
        strokeWidth="1"
      />
      {evidence.threshold !== null && (
        <line
          x1={PAD.left}
          x2={W - PAD.right}
          y1={y(evidence.threshold)}
          y2={y(evidence.threshold)}
          className="stroke-foreground/50"
          strokeDasharray="1 3"
          strokeWidth="1.5"
        />
      )}
      <path d={area} fill="url(#fill)" className="text-foreground" />
      <path d={line} fill="none" className="stroke-foreground" strokeWidth="1.75" strokeLinejoin="round" />
      {series.map((p, i) => (
        <circle
          key={p.week}
          cx={x(i)}
          cy={y(p.value)}
          r={i >= series.length - recentWeeks ? 3.2 : 1.8}
          className={i >= series.length - recentWeeks ? "fill-foreground" : "fill-muted-foreground"}
        />
      ))}
    </svg>
  );
}
