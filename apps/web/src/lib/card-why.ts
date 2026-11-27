import type { Card } from "@/lib/client-api";
import { num, roundMoney } from "@/lib/format";

/**
 * Why a card is on someone's list, in terms the owner can check, built only from the numbers on the
 * card. Each line is a message key with its values, so the app shows it in the owner's language. No
 * AI: the card's own evidence says it (the rule that let it through, and how big the problem is).
 */

export type WhyLine = {
  key: "threshold" | "zscore" | "wow" | "other" | "impact" | "confidence";
  /** Which way the number sits against what it is compared to; the sentence turns it into words. */
  side?: "above" | "below";
  values: Record<string, string | number>;
};

export function whyLines(card: Card, locale: string): WhyLine[] {
  const e = card.evidence;
  const unit = e.unit ? ` ${e.unit}` : "";
  const base = { metric: e.metric ?? "", where: e.entity ? ` (${e.entity})` : "", unit };
  const lines: WhyLine[] = [];

  if (e.signal_kind === "threshold" && e.current_value != null && e.threshold != null) {
    lines.push({
      key: "threshold",
      side: e.current_value > e.threshold ? "above" : "below",
      values: { ...base, value: num(e.current_value, locale, 1), limit: num(e.threshold, locale, 1) },
    });
  } else if (e.signal_kind === "zscore" && e.baseline_mean != null) {
    const pct = e.change_vs_baseline_pct;
    lines.push({
      key: "zscore",
      side: pct != null && pct < 0 ? "below" : "above",
      values: { ...base, pct: pct != null ? num(Math.abs(pct), locale, 0) : "", usual: num(e.baseline_mean, locale, 1) },
    });
  } else if (e.signal_kind === "wow_change") {
    lines.push({ key: "wow", values: { ...base, usual: num(e.baseline_mean, locale, 1) } });
  } else {
    lines.push({ key: "other", values: base });
  }

  if (Number(card.expected_impact) > 0) {
    lines.push({ key: "impact", values: { impact: roundMoney(card.expected_impact, card.impact_unit, locale) } });
  }
  lines.push({ key: "confidence", values: { n: Math.round(Number(card.confidence) * 100) } });
  return lines;
}
