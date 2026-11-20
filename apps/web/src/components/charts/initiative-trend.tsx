export type TrendPoint = { label: string; value: number; kind: "baseline" | "review" | "latest" | "reading" };

/** A small line chart for one initiative: readings over time, the baseline as a dashed line, the review
 * date as a dashed vertical line and the latest reading as the dark point. The line draws itself in. */
export function InitiativeTrend({
  points,
  baseline,
  format,
  legend,
}: {
  points: TrendPoint[];
  baseline: number;
  format: (v: number) => string;
  legend: { baseline: string; review: string | null; latest: string };
}) {
  const W = 900;
  const H = 250;
  const padX = 78;
  const padTop = 22;
  const padBottom = 24;
  const values = [...points.map((p) => p.value), baseline];
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi === lo) {
    hi += 1;
    lo -= 1;
  }
  const span = hi - lo;
  lo -= span * 0.12;
  hi += span * 0.12;
  const x = (i: number) => padX + (points.length === 1 ? (W - padX * 2) / 2 : (i * (W - padX * 2 - 20)) / (points.length - 1));
  const y = (v: number) => padTop + ((hi - v) / (hi - lo)) * (H - padTop - padBottom);
  const path = points.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const review = points.findIndex((p) => p.kind === "review");
  const ticks = [hi - (hi - lo) * 0.12, (hi + lo) / 2, lo + (hi - lo) * 0.12];
  return (
    <figure className="ini-trend">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={points.map((p) => `${p.label}: ${format(p.value)}`).join(", ")}>
        {ticks.map((t) => (
          <g key={t}>
            <path className="ini-grid" d={`M${padX} ${y(t)}H${W - 8}`} />
            <text x={0} y={y(t) + 4} className="ini-tick">
              {format(t)}
            </text>
          </g>
        ))}
        <path className="ini-baseline" d={`M${padX} ${y(baseline)}H${W - 8}`} />
        {review >= 0 && <path className="ini-review" d={`M${x(review)} ${padTop - 6}V${H - padBottom + 8}`} />}
        <path className="ini-line" pathLength={1} d={path} />
        {points.map((p, i) => (
          <circle key={`${p.label}-${i}`} className={p.kind === "latest" ? "ini-dot ini-dot-latest" : "ini-dot"} cx={x(i)} cy={y(p.value)} r={p.kind === "latest" ? 5 : 4.5} style={{ animationDelay: `${250 + i * 160}ms` }}>
            <title>{`${p.label}: ${format(p.value)}`}</title>
          </circle>
        ))}
      </svg>
      <figcaption>
        <span className="ini-key ini-key-baseline">{legend.baseline}</span>
        {legend.review && <span className="ini-key ini-key-review">{legend.review}</span>}
        <span className="ini-key ini-key-latest">{legend.latest}</span>
      </figcaption>
    </figure>
  );
}
