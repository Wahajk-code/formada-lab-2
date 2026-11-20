"use client";

import { ChevronDown, Users } from "lucide-react";
import { useId, useState } from "react";

import { type UnitLabels, formatValue } from "@/components/dashboard/executive/format";
import type { Suggestion } from "@/mocks/executive-overview";

export type SuggestionLabels = {
  impact: string;
  /** A template with {n}. */
  confidence: string;
  what: string;
  soWhat: string;
  nowWhat: string;
  expectedImpact: string;
  current: string;
  previous: string;
  supporting: string;
  baseline: string;
  change: string;
  showMore: string;
  showFewer: string;
};

const FIRST = 7;

function Row({ s, locale, units, labels }: { s: Suggestion; locale: string; units: UnitLabels; labels: SuggestionLabels }) {
  const [open, setOpen] = useState(false);
  const [evidence, setEvidence] = useState(false);
  const id = useId();
  const money = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(s.impact);
  const r = s.current;
  return (
    <li className="ex-sug-row" data-open={open}>
      <button type="button" className="ex-sug-head" aria-expanded={open} aria-controls={id} onClick={() => setOpen((v) => !v)}>
        <span>
          <strong>{s.title}</strong>
          <small>
            {s.role} · {s.metric}
          </small>
        </span>
        <span className="ex-sug-impact">
          <b>${money}</b>
          <small>{labels.impact}</small>
        </span>
        <ChevronDown size={18} aria-hidden="true" />
      </button>
      <div id={id} className="ex-fold" data-open={open}>
        <div className="ex-fold-inner">
          <div className="ex-sug-card">
            <header>
              <span className="ex-sug-who">
                <span>
                  <Users size={16} aria-hidden="true" />
                </span>
                <span>
                  <strong>{s.role}</strong>
                  <small>{s.department}</small>
                </span>
              </span>
              <span className="ex-sug-conf">{labels.confidence.replace("{n}", String(s.confidence))}</span>
            </header>
            <div className="ex-sug-body">
              <h4>{s.headline}</h4>
              <dl>
                <dt>{labels.what}</dt>
                <dd>{s.what}</dd>
                <dt>{labels.soWhat}</dt>
                <dd>{s.soWhat}</dd>
                <dt>{labels.nowWhat}</dt>
                <dd>{s.nowWhat}</dd>
              </dl>
              <div className="ex-sug-facts">
                <p>
                  <small>{labels.expectedImpact}</small>
                  <b>
                    ${money} <i>CAD</i>
                  </b>
                </p>
                <p>
                  <small>{labels.current}</small>
                  <b>{formatValue(r.value, r, locale, units)}</b>
                </p>
                <p>
                  <small>{labels.previous}</small>
                  <b>{formatValue(r.prior, r, locale, units)}</b>
                </p>
              </div>
              <button type="button" className="ex-sug-evidence" aria-expanded={evidence} onClick={() => setEvidence((v) => !v)}>
                <span>{labels.supporting}</span>
                <ChevronDown size={16} aria-hidden="true" />
              </button>
              <div className="ex-fold" data-open={evidence}>
                <div className="ex-fold-inner">
                  <dl className="ex-sug-table">
                    <dt>{labels.baseline}</dt>
                    <dd>{formatValue(r.prior, r, locale, units)}</dd>
                    <dt>{labels.current}</dt>
                    <dd>{formatValue(r.value, r, locale, units)}</dd>
                    <dt>{labels.change}</dt>
                    <dd>{formatValue(r.delta, r, locale, units, true)}</dd>
                  </dl>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </li>
  );
}

/** Recommended actions, ranked by expected impact. Rows open in place; the list shows the first few. */
export function SuggestionList({ items, locale, units, labels }: { items: Suggestion[]; locale: string; units: UnitLabels; labels: SuggestionLabels }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, FIRST);
  return (
    <>
      <ul className="ex-sug-list dw-stagger">
        {shown.map((s) => (
          <Row key={s.id} s={s} locale={locale} units={units} labels={labels} />
        ))}
      </ul>
      {items.length > FIRST && (
        <div className="ex-sug-more">
          <button type="button" className="ex-chip ex-chip-btn" onClick={() => setAll((v) => !v)}>
            <ChevronDown size={16} aria-hidden="true" style={{ transform: all ? "rotate(180deg)" : undefined }} />
            <span>{all ? labels.showFewer : labels.showMore}</span>
          </button>
        </div>
      )}
    </>
  );
}
