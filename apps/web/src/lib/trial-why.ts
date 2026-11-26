import type { CardFull } from "@/lib/client-api";

/**
 * Why a trial card exists, in plain words, built only from the numbers on the card. It names the rule
 * that let the problem through and what to change to get fewer or more cards like it, so tuning a card
 * is a decision with the reason in front of you. No AI: the card's own evidence says it.
 */

const n = (v: number, d = 1) => (Math.round(v * 10 ** d) / 10 ** d).toLocaleString("en-CA");

export type Why = { reasons: string[]; tune: string[] };

export function whyCard(c: CardFull): Why {
  const unit = c.unit ? ` ${c.unit}` : "";
  const what = c.metric ?? "This measure";
  const where = c.entity ? ` for ${c.entity}` : "";
  const reasons: string[] = [];
  const tune: string[] = [];
  const cur = c.current_value;
  const base = c.baseline_mean;
  const pct = c.change_vs_baseline_pct;

  if (c.signal_kind === "threshold" && cur != null && c.threshold != null) {
    const above = cur > c.threshold;
    reasons.push(`${what}${where} is ${n(cur)}${unit}, ${above ? "above" : "below"} the alert level of ${n(c.threshold)}${unit}. An alert level fires whatever the trend.`);
    tune.push(`Move this measure's alert level for this role (Metrics step): ${above ? "higher" : "lower"} for fewer cards like this, the other way for more.`);
  } else if (c.signal_kind === "zscore" && cur != null && base != null) {
    reasons.push(
      `${what}${where} has been ${pct != null ? `${n(Math.abs(pct))}% ${pct >= 0 ? "above" : "below"}` : "away from"} its usual ${n(base)}${unit} for several weeks, a bigger move than its normal week-to-week variation, in the direction that hurts.`,
    );
    tune.push(`The "how unusual" rule (zscore threshold): raise it for fewer cards like this, lower it for more.`);
  } else if (c.signal_kind === "wow_change") {
    reasons.push(`${what}${where} changed sharply in the latest week${base != null ? `, against a usual level of ${n(base)}${unit}` : ""}, in the direction that hurts.`);
    tune.push(`The week-over-week change rule: raise it for fewer cards like this, lower it for more.`);
  } else {
    reasons.push(`${what}${where} moved the wrong way against its history.`);
  }

  if (c.impact > 0) {
    reasons.push(`About ${n(c.impact, 0)} ${c.impact_unit} is at stake, above the money floor, so it was kept.`);
    tune.push(`The money floor (smallest problem worth a card): raise it so smaller problems stop appearing, lower it to see more.`);
  }
  reasons.push(`Confidence ${Math.round(c.confidence * 100)}%, worked out by code from how clear and how long the evidence is.`);
  return { reasons, tune };
}
