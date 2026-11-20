"use client";

import { useMemo, useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { Article, Block } from "@/content/help";

function flat(a: Article) {
  return [a.group, a.title, a.summary, ...a.sections.flatMap((s) => [s.h, ...s.blocks.flatMap((b) => ("p" in b ? [b.p] : "dl" in b ? b.dl.flat() : b.steps))])].join(" ").toLowerCase();
}

function Body({ block }: { block: Block }) {
  if ("p" in block) return <p>{block.p}</p>;
  if ("steps" in block)
    return (
      <ol>
        {block.steps.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ol>
    );
  return (
    <dl>
      {block.dl.map(([term, def]) => (
        <div key={term}>
          <dt>
            <strong>{term}</strong>
          </dt>
          <dd>{def}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The help list (Formada.AI design): a search box and one expandable row per topic. */
export function HelpCenter({
  articles,
  current,
  labels,
}: {
  articles: Article[];
  current: string | null;
  labels: { search: string; placeholder: string; noMatch: string };
}) {
  const [q, setQ] = useState("");
  const index = useMemo(() => articles.map((a) => ({ a, text: flat(a) })), [articles]);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = index.filter(({ text }) => terms.every((t) => text.includes(t))).map(({ a }) => a);
  return (
    <div className="utility-card help-card">
      <label className="screen-field" htmlFor="helpSearch">
        {labels.search}
        <span className="screen-search">
          <Icon name="search" size={18} />
          <input id="helpSearch" type="search" placeholder={labels.placeholder} value={q} onChange={(e) => setQ(e.target.value)} />
        </span>
      </label>
      <div className="help-list">
        {shown.length ? (
          shown.map((a) => (
            <details key={a.slug} id={a.slug} open={current === a.slug}>
              <summary>
                <span>
                  <span className="eyebrow">{a.group}</span>
                  <strong>{a.title}</strong>
                </span>
                <Icon name="chevron-down" size={17} />
              </summary>
              <p>{a.summary}</p>
              {a.sections.map((s) => (
                <div key={s.h}>
                  <p>
                    <strong>{s.h}</strong>
                  </p>
                  {s.blocks.map((b, i) => (
                    <Body key={i} block={b} />
                  ))}
                </div>
              ))}
            </details>
          ))
        ) : (
          <p className="screen-subtitle" role="status">
            {labels.noMatch}
          </p>
        )}
      </div>
    </div>
  );
}
