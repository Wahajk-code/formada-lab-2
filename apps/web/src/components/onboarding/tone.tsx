/** Colour coding for onboarding status (ADR 0027): green good, blue matched or linked, amber
 * partial or medium, red missing or high. Everything else stays monochrome. */
export type Tone = "good" | "matched" | "partial" | "missing" | "neutral";

export const TONE: Record<Tone, string> = {
  good: "bg-[var(--positive)] text-[var(--positive-ink)] ring-1 ring-transparent",
  matched: "bg-[var(--soft-violet)] text-[var(--iris-ink)] ring-1 ring-transparent",
  partial: "bg-[var(--attention)] text-[var(--attention-ink)] ring-1 ring-transparent",
  missing: "bg-[var(--critical)] text-[var(--critical-ink)] ring-1 ring-transparent",
  neutral: "bg-surface text-muted-foreground",
};

export const DOT: Record<Tone, string> = {
  good: "bg-[var(--jade)]",
  matched: "bg-[var(--iris)]",
  partial: "bg-[var(--attention-ink)]",
  missing: "bg-[var(--critical-ink)]",
  neutral: "bg-muted-foreground/40",
};

export const STROKE: Record<Tone, string> = {
  good: "#10b981",
  matched: "#0ea5e9",
  partial: "#f59e0b",
  missing: "#f43f5e",
  neutral: "#a3a3a3",
};

export const coverageTone = (s: string): Tone => (s === "present" ? "good" : s === "partial" ? "partial" : "missing");
export const severityTone = (s: string): Tone => (s === "high" ? "missing" : s === "medium" ? "partial" : "neutral");
export const confidenceTone = (s: string): Tone => (s === "high" ? "matched" : s === "medium" ? "partial" : "missing");
export const fillTone = (pct: number | null | undefined): Tone =>
  pct == null ? "neutral" : pct >= 95 ? "good" : pct >= 50 ? "partial" : "missing";

export function Pill({ tone, children }: { tone: Tone; children: React.ReactNode }) {
  return <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${TONE[tone]}`}>{children}</span>;
}
