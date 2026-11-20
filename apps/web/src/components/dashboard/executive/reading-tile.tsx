"use client";

import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { type UnitLabels, formatValue } from "@/components/dashboard/executive/format";
import type { Reading } from "@/mocks/executive-overview";

/** Eases a number up to its value on mount and whenever the value changes. Starts close to the final
 * value so the first paint is already right, and stays still for people who prefer reduced motion. */
function useCountUp(value: number) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      from.current = value;
      return;
    }
    const start = from.current === value ? value * 0.9 : from.current;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const k = Math.min(1, (now - t0) / 720);
      const eased = 1 - Math.pow(1 - k, 3);
      setShown(start + (value - start) * eased);
      if (k < 1) raf = requestAnimationFrame(tick);
      else from.current = value;
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [value]);
  return shown;
}

export type TileLabels = {
  /** A template with {value}, filled in here so the labels stay plain strings across the server boundary. */
  prior: string;
  improving: string;
  attention: string;
  nextStep: string;
  viewSuggestion: string;
};

/** One reading: name, value, prior value and a delta pill. In the current view it also carries the
 * role it belongs to and, when something moved the wrong way, the suggested next step. */
export function ReadingTile({
  reading: r,
  locale,
  units,
  labels,
  showRole = false,
  showNext = false,
  large = false,
}: {
  reading: Reading;
  locale: string;
  units: UnitLabels;
  labels: TileLabels;
  showRole?: boolean;
  showNext?: boolean;
  large?: boolean;
}) {
  const shown = useCountUp(r.value);
  const good = r.trend === "improving";
  const Arrow = good ? ArrowUpRight : ArrowDownRight;
  const fmt = (v: number, sign = false) => formatValue(v, r, locale, units, sign);
  return (
    <article className={large ? "ex-tile ex-tile-lg" : "ex-tile"}>
      <p className="ex-tile-name">{r.name}</p>
      <p className="ex-value" aria-label={fmt(r.value)}>
        {fmt(Math.abs(shown - r.value) < 1e-9 ? r.value : +shown.toFixed(r.decimals))}
      </p>
      {showRole && <p className="ex-tile-role">{r.role}</p>}
      <div className="ex-tile-foot">
        <span className="ex-prior">{labels.prior.replace("{value}", fmt(r.prior))}</span>
        <span className={good ? "ex-pill ex-pill-good" : "ex-pill ex-pill-warn"}>
          <Arrow size={13} aria-hidden="true" />
          {fmt(r.delta, true)} <b>{good ? labels.improving : labels.attention}</b>
        </span>
      </div>
      {showNext && r.suggestion && (
        <div className="ex-next">
          <strong>{labels.nextStep}</strong>
          <p>{r.suggestion}</p>
          <Link href="/initiatives">
            {labels.viewSuggestion} <ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      )}
    </article>
  );
}
