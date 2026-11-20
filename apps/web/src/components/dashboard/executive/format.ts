import type { Reading } from "@/mocks/executive-overview";

export type UnitLabels = { orders: string; days: string };

/** "$15,150,774 CAD", "222,933.76", "110.85 orders". `sign` adds an explicit + or − for deltas. */
export function formatValue(value: number, r: Pick<Reading, "unit" | "decimals">, locale: string, units: UnitLabels, sign = false) {
  const n = new Intl.NumberFormat(locale, { minimumFractionDigits: r.decimals, maximumFractionDigits: r.decimals }).format(Math.abs(value));
  const s = value < 0 ? "−" : sign ? "+" : "";
  if (r.unit === "CAD") return `${s}$${n} CAD`;
  if (r.unit === "USD") return `${s}${n} USD`;
  if (r.unit === "orders") return `${s}${n} ${units.orders}`;
  if (r.unit === "days") return `${s}${n} ${units.days}`;
  return `${s}${n}`;
}
