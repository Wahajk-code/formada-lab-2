"use client";

/**
 * The main table over time, as a picture: one bar per snapshot (height = rows), coloured by how
 * often snapshots arrive, with marks where days or weeks are missing and where the row count
 * drops. Replaces the table of cadence runs: the eye sees weekly then daily, and the gaps.
 */

import { fmt } from "@/components/console/onboarding/review-kit";

type Point = { date: string; rows: number };
export type Segment = { step: number; from: string; to: string; snapshots: number };
export type Mark = { date: string; kind: "missing" | "skipped"; text: string };

const DAY = 86_400_000;
const t = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const gapDays = (a: string, b: string) => Math.round((t(b) - t(a)) / DAY);

/** Steps of 5 to 8 days are a weekly rhythm (a shifted day is not a gap); 1 is daily. */
const rhythm = (d: number) => (d === 1 ? 1 : d >= 5 && d <= 8 ? 7 : 0);

/** Split the dates into steady rhythms and the gaps inside them. Pure, so it can be reasoned about. */
export function readTimeline(points: Point[]): { segments: Segment[]; marks: Mark[] } {
  const dates = [...points].map((p) => p.date).sort();
  const segments: Segment[] = [];
  const marks: Mark[] = [];
  if (dates.length < 2) return { segments: dates.length ? [{ step: 0, from: dates[0], to: dates[0], snapshots: 1 }] : [], marks };
  let cur: Segment | null = null;
  for (let i = 1; i < dates.length; i++) {
    const d = gapDays(dates[i - 1], dates[i]);
    const r = rhythm(d);
    if (cur && r === cur.step) {
      cur.to = dates[i];
      cur.snapshots += 1;
      continue;
    }
    // A gap inside the current rhythm: daily with a few days missing, or weekly with a week skipped.
    const next = i + 1 < dates.length ? rhythm(gapDays(dates[i], dates[i + 1])) : (cur?.step ?? 0);
    if (cur && r === 0 && next === cur.step && d < cur.step * 6) {
      if (cur.step === 1) {
        const first = iso(t(dates[i - 1]) + DAY);
        const last = iso(t(dates[i]) - DAY);
        marks.push({ date: first, kind: "missing", text: first === last ? fmt.date(first) : fmt.range(first, last) });
      } else {
        marks.push({ date: iso(t(dates[i - 1]) + 7 * DAY), kind: "skipped", text: `week of ${fmt.date(iso(t(dates[i - 1]) + 7 * DAY))}` });
      }
      cur.to = dates[i];
      cur.snapshots += 1;
      continue;
    }
    cur = { step: r || d, from: dates[i - 1], to: dates[i], snapshots: 2 };
    // The start date was already counted by the segment before.
    if (segments.length && segments[segments.length - 1].to === dates[i - 1]) cur.snapshots = 1;
    segments.push(cur);
  }
  // Merge tiny transition segments (one step that is neither weekly nor daily) into a mark-free join.
  return { segments: segments.filter((s, i) => !(s.snapshots <= 1 && rhythm(s.step) === 0 && i > 0)), marks };
}

export function DataTimeline({ points, breaks }: { points: Point[]; breaks: { from: string; to: string; rows?: number[] }[] }) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const { segments, marks } = readTimeline(sorted);
  const W = 1000;
  const H = 168;
  const top = 14;
  const base = 112; // bottom of the chart
  const band = 120; // the rhythm band under it
  const start = t(sorted[0].date);
  const span = t(sorted[sorted.length - 1].date) - start || 1;
  const x = (d: string) => 6 + ((t(d) - start) / span) * (W - 12);
  const max = Math.max(...sorted.map((p) => p.rows), 1);
  const y = (rows: number) => base - ((base - top) * rows) / max;
  const tone = (step: number) => (step === 1 ? "rv-tl-daily" : step === 7 ? "rv-tl-weekly" : "rv-tl-other");
  const label = (s: Segment) => cap(fmt.days(s.step));
  // The rows line over the whole period, filled under it.
  const line = sorted.map((p, i) => `${i ? "L" : "M"} ${x(p.date).toFixed(1)} ${y(p.rows).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(sorted[sorted.length - 1].date).toFixed(1)} ${base} L ${x(sorted[0].date).toFixed(1)} ${base} Z`;
  // Axis labels: the first date, each change of rhythm, the last date; drop a label that would collide.
  const ticks: { d: string; align: "start" | "middle" | "end" }[] = [{ d: sorted[0].date, align: "start" }];
  for (const sg of segments.slice(1)) ticks.push({ d: sg.from, align: "middle" });
  ticks.push({ d: sorted[sorted.length - 1].date, align: "end" });
  const shown = ticks.filter((tk, i) => i === 0 || i === ticks.length - 1 || (x(tk.d) - x(ticks[0].d) > 150 && x(ticks[ticks.length - 1].d) - x(tk.d) > 150));
  return (
    <figure className="rv-timeline">
      <div className="rv-tl-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rows per snapshot from ${fmt.date(sorted[0].date)} to ${fmt.date(sorted[sorted.length - 1].date)}. ${segments.map((sg) => `${label(sg)} ${fmt.range(sg.from, sg.to)}`).join(". ")}.`}>
          <defs>
            <linearGradient id="rv-tl-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#8f6fe0" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#8f6fe0" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <line x1={0} x2={W} y1={top} y2={top} className="rv-tl-grid" />
          <text x={W - 4} y={top - 3} textAnchor="end" className="rv-tl-scale">
            {fmt.count(max)} rows
          </text>
          <path d={area} fill="url(#rv-tl-fill)" />
          <path d={line} className="rv-tl-line" />
          {sorted.map((p) => (
            <circle key={p.date} cx={x(p.date)} cy={y(p.rows)} r={6} className="rv-tl-hit">
              <title>{`${fmt.date(p.date)}: ${fmt.exact(p.rows)} rows`}</title>
            </circle>
          ))}
          <line x1={0} x2={W} y1={base} y2={base} className="rv-tl-axis" />
          {segments.map((sg) => (
            <rect key={sg.from} x={x(sg.from)} y={band} width={Math.max(3, x(sg.to) - x(sg.from))} height={10} rx={3} className={tone(sg.step)}>
              <title>{`${label(sg)}: ${fmt.range(sg.from, sg.to)}, ${fmt.plural(sg.snapshots, "snapshot")}`}</title>
            </rect>
          ))}
          {marks.map((m) => (
            <g key={m.date} className="rv-tl-gap">
              <line x1={x(m.date)} x2={x(m.date)} y1={band - 3} y2={band + 13} />
              <title>{m.kind === "missing" ? `Missing: ${m.text}` : `Skipped: ${m.text}`}</title>
            </g>
          ))}
          {breaks.map((b) => (
            <g key={b.to} className="rv-tl-break">
              <line x1={x(b.to)} x2={x(b.to)} y1={top} y2={base} />
              <title>{`Row count drop on ${fmt.date(b.to)}${b.rows ? `: ${b.rows.map(fmt.exact).join(" → ")} rows` : ""}`}</title>
            </g>
          ))}
                  {shown.map((tk) => (
            <text key={tk.d} x={x(tk.d)} y={H - 6} textAnchor={tk.align} className="rv-tl-label">
              {fmt.date(tk.d)}
            </text>
          ))}
        </svg>
      </div>
      <figcaption className="rv-tl-legend">
        {segments.map((s) => (
          <span key={s.from}>
            <i className={tone(s.step)} aria-hidden />
            <b>{label(s)}</b> {fmt.range(s.from, s.to)} <small>· {fmt.plural(s.snapshots, "snapshot")}</small>
          </span>
        ))}
        {marks.length > 0 && (
          <span>
            <i className="rv-tl-gap-key" aria-hidden />
            Gap
          </span>
        )}
        {breaks.length > 0 && (
          <span>
            <i className="rv-tl-break-key" aria-hidden />
            Row drop
          </span>
        )}
      </figcaption>
    </figure>
  );
}

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
