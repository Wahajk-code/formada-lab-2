"use client";

/**
 * The main table over time, as one line: how many rows the table held on each date. The only mark
 * on it is a sudden drop (or jump) in rows, said in words on the chart. How often snapshots arrive
 * (weekly, then daily) and whether any are missing is one sentence under it.
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

const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

/** "Counted weekly from 8 Dec 2024 to 18 Sep 2026, then daily to 13 Nov 2026. 3 gaps." */
function rhythmSentence(segments: Segment[], marks: Mark[]): string {
  const parts = segments.map((s, i) => `${i ? "then " : ""}${fmt.days(s.step)} ${fmt.range(s.from, s.to)}`);
  const gaps = marks.length ? ` ${cap(fmt.plural(marks.length, "gap"))} where a ${marks.some((m) => m.kind === "missing") ? "day" : "week"} is missing.` : " Nothing is missing.";
  return `Counted ${parts.join(", ")}.${gaps}`;
}

export function DataTimeline({ points, breaks }: { points: Point[]; breaks: { from: string; to: string; rows?: number[] }[] }) {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  if (sorted.length < 2) return null;
  const { segments, marks } = readTimeline(sorted);
  const W = 1000;
  const H = 200;
  const top = 40; // room above the line for the note on a drop
  const base = 160; // the zero line
  const start = t(sorted[0].date);
  const span = t(sorted[sorted.length - 1].date) - start || 1;
  const x = (d: string) => 6 + ((t(d) - start) / span) * (W - 12);
  const max = Math.max(...sorted.map((p) => p.rows), 1);
  const y = (rows: number) => base - ((base - top) * rows) / max;
  const line = sorted.map((p, i) => `${i ? "L" : "M"} ${x(p.date).toFixed(1)} ${y(p.rows).toFixed(1)}`).join(" ");
  const area = `${line} L ${x(sorted[sorted.length - 1].date).toFixed(1)} ${base} L ${x(sorted[0].date).toFixed(1)} ${base} Z`;
  // The note on a drop: "55% fewer rows, 19 Oct 2026". It sits on the side with room.
  const notes = breaks.flatMap((b) => {
    if (!b.rows || b.rows.length < 2 || !b.rows[0]) return [];
    const change = Math.round((100 * (b.rows[1] - b.rows[0])) / b.rows[0]);
    const right = x(b.to) > W * 0.55;
    return [{ b, x: x(b.to), anchor: right ? ("end" as const) : ("start" as const), text: `${Math.abs(change)}% ${change < 0 ? "fewer" : "more"} rows on ${fmt.date(b.to)}`, from: b.rows[0], to: b.rows[1] }];
  });
  return (
    <figure className="rv-timeline">
      <div className="rv-tl-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Rows in the table from ${fmt.date(sorted[0].date)} to ${fmt.date(sorted[sorted.length - 1].date)}. ${notes.map((n) => n.text).join(". ")}`}>
          <defs>
            <linearGradient id="rv-tl-fill" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor="#8f6fe0" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#8f6fe0" stopOpacity="0.04" />
            </linearGradient>
          </defs>
          <line x1={0} x2={W} y1={top} y2={top} className="rv-tl-grid" />
          <text x={4} y={top - 6} className="rv-tl-scale">
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
          {notes.map((n) => (
            <g key={n.b.to} className="rv-tl-break">
              <line x1={n.x} x2={n.x} y1={top - 2} y2={base} />
              <circle cx={n.x} cy={y(n.from)} r={5} className="rv-tl-dot" />
              <circle cx={n.x} cy={y(n.to)} r={5} className="rv-tl-dot" />
              <text x={n.x + (n.anchor === "end" ? -10 : 10)} y={top + 14} textAnchor={n.anchor} className="rv-tl-note">
                {n.text}
              </text>
              <title>{`${fmt.exact(n.from)} rows, then ${fmt.exact(n.to)} rows`}</title>
            </g>
          ))}
          <text x={4} y={H - 8} textAnchor="start" className="rv-tl-label">
            {fmt.date(sorted[0].date)}
          </text>
          <text x={W - 4} y={H - 8} textAnchor="end" className="rv-tl-label">
            {fmt.date(sorted[sorted.length - 1].date)}
          </text>
        </svg>
      </div>
      <figcaption className="rv-tl-sum">{rhythmSentence(segments, marks)}</figcaption>
    </figure>
  );
}
