const tag = (locale: string) => (locale === "fr" ? "fr-CA" : "en-CA");

export function money(value: number | string, currency: string, locale: string, compact = false) {
  return new Intl.NumberFormat(tag(locale), {
    style: "currency",
    currency,
    maximumFractionDigits: 0,
    notation: compact ? "compact" : "standard",
  }).format(Number(value));
}

/** Money at the client's scale: $3.07M, $241K, $830. Exact amounts stay in the evidence. */
export function roundMoney(value: number | string, currency: string, locale: string) {
  const v = Number(value);
  return new Intl.NumberFormat(tag(locale), {
    style: "currency",
    currency,
    notation: Math.abs(v) >= 10000 ? "compact" : "standard",
    maximumSignificantDigits: Math.abs(v) >= 10000 ? 3 : undefined,
    maximumFractionDigits: 0,
  }).format(v);
}

export function num(value: number | string | null | undefined, locale: string, digits = 1) {
  if (value === null || value === undefined) return "–";
  return new Intl.NumberFormat(tag(locale), { maximumFractionDigits: digits }).format(Number(value));
}

export function day(iso: string, locale: string) {
  return new Intl.DateTimeFormat(tag(locale), { month: "short", day: "numeric" }).format(new Date(iso));
}

/** Units that read as a suffix ("27 days", "23 %") rather than a currency. */
export function withUnit(value: number | string, unit: string, locale: string) {
  return unit === "CAD" ? money(value, unit, locale) : `${num(value, locale)} ${unit}`;
}

export function dateTime(iso: string, locale: string) {
  return new Intl.DateTimeFormat(tag(locale), {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Toronto",
  }).format(new Date(iso));
}

export function fullDay(iso: string, locale: string) {
  return new Intl.DateTimeFormat(tag(locale), { year: "numeric", month: "short", day: "numeric" }).format(
    new Date(iso),
  );
}

/** "3 hours ago", "in 2 days": coarse, for run times. */
export function relative(iso: string, locale: string, now = Date.now()) {
  const diff = (new Date(iso).getTime() - now) / 1000;
  const rtf = new Intl.RelativeTimeFormat(tag(locale), { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [unit, s] of steps) if (Math.abs(diff) >= s) return rtf.format(Math.round(diff / s), unit);
  return rtf.format(Math.round(diff), "second");
}

export function pct(value: number | null | undefined, locale: string) {
  if (value === null || value === undefined) return "–";
  return new Intl.NumberFormat(tag(locale), { style: "percent", maximumFractionDigits: 0 }).format(value);
}
