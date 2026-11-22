"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useMemo, useState } from "react";

import { AddLink, CardBar, CardEditor, GroupBar, type CardCtx } from "@/components/console/onboarding/card-tools";
import { COVERAGE, fmt, Fold, humanDates, Lines, makeNamer, Section, Status, Sub } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { OnboardingGuide } from "@/lib/console-api";
import { AREA_FAMILIES, AREA_KEYS, AREA_LABEL, areaOf, cardId, type AreaKey } from "@/lib/discovery-cards";
import { cn } from "@/lib/utils";

/**
 * How the customer's tables connect, one area at a time. Tables are boxes, links are lines: the table
 * that holds the rows on the left, the tables it looks things up in on the right. A table with no
 * link at all is listed under the picture, because a table nothing connects to cannot be used.
 * Every link is a card: the team can change it, lock it, remove it, add a missing one, or hand it
 * to the chat. What the team decides here is what Mapping reads (the API swaps it into the profile).
 */

type Link = { id: string; from: string; to: string; keys: string; ref: string; source: string; note: string; raw: any };

const BOX_W = 215;
const BOX_H = 54;
const GAP = 14;
const MID = 150;
const PAD = 44; // room on the left for a link between two tables of the same column
const WIDTH = PAD + BOX_W + MID + BOX_W;

const spread = (k: number, n: number) => (k - (n - 1) / 2) * 9;

export function ViewDiagram({ out, guide, cards }: { out: any; guide: OnboardingGuide | null; cards?: CardCtx }) {
  const views = useMemo(() => guide?.semantic_views ?? [], [guide]);
  const nameOf = useMemo(() => makeNamer(views), [views]);
  const tables = useMemo(
    () => views.flatMap((v) => v.tables.map((t) => ({ table: t.table, view: v.view, measures: t.metrics.length, comment: t.comment }))),
    [views],
  );
  const links: Link[] = useMemo(
    () =>
      ((out.links ?? []) as any[]).map((raw) => ({
        id: cardId("link", raw),
        from: raw.from_table,
        to: raw.to_table,
        keys: raw.keys,
        ref: raw.ref_keys,
        source: raw.source,
        note: raw.note ?? "",
        raw,
      })),
    [out.links],
  );
  const linked = useMemo(() => new Set(links.flatMap((l) => [l.from, l.to])), [links]);
  const present = AREA_KEYS.filter((a) => links.some((l) => areaOf(l.from) === a) || tables.some((t) => areaOf(t.table) === a));
  const [area, setArea] = useState<AreaKey>(present.find((a) => links.some((l) => areaOf(l.from) === a)) ?? present[0] ?? "sales");
  const [picked, setPicked] = useState<string | null>(null);

  const areaLinks = links.filter((l) => areaOf(l.from) === area);
  const left = [...new Set(areaLinks.map((l) => l.from))];
  const right = [...new Set(areaLinks.map((l) => l.to))].filter((t) => !left.includes(t));
  const rows = Math.max(left.length, right.length, 1);
  const height = rows * (BOX_H + GAP) - GAP;
  const unlinked = tables.filter((t) => areaOf(t.table) === area && !linked.has(t.table));
  const sel = areaLinks.find((l) => l.id === picked) ?? areaLinks[0];

  // Where each line leaves and enters a box: several lines on one box are spread along its edge.
  const out_ = new Map<string, number>();
  const into = new Map<string, number>();
  for (const l of areaLinks) {
    out_.set(l.from, (out_.get(l.from) ?? 0) + 1);
    into.set(l.to, (into.get(l.to) ?? 0) + 1);
  }
  const seenOut = new Map<string, number>();
  const seenIn = new Map<string, number>();
  const topOf = (side: "l" | "r", table: string) => (side === "l" ? left.indexOf(table) : right.indexOf(table)) * (BOX_H + GAP);
  const wires = areaLinks.map((l) => {
    const a = seenOut.get(l.from) ?? 0;
    const b = seenIn.get(l.to) ?? 0;
    seenOut.set(l.from, a + 1);
    seenIn.set(l.to, b + 1);
    const y1 = topOf("l", l.from) + BOX_H / 2 + spread(a, out_.get(l.from) ?? 1);
    const backToLeft = left.includes(l.to);
    const y2 = (backToLeft ? topOf("l", l.to) : topOf("r", l.to)) + BOX_H / 2 + spread(b, into.get(l.to) ?? 1);
    const d = backToLeft
      ? `M ${PAD} ${y1} C ${PAD - 40} ${y1}, ${PAD - 40} ${y2}, ${PAD} ${y2}`
      : `M ${PAD + BOX_W} ${y1} C ${PAD + BOX_W + MID * 0.55} ${y1}, ${PAD + BOX_W + MID * 0.45} ${y2}, ${PAD + BOX_W + MID} ${y2}`;
    return { l, d };
  });

  // What the AI says about this area: its coverage lines and its reading of the views the tables live in.
  const coverage = ((out.coverage ?? []) as any[]).filter((c) => AREA_FAMILIES[area].includes(c.family));
  const viewNames = new Set(tables.filter((t) => areaOf(t.table) === area).map((t) => t.view));
  const reads = ((out.semantic_views ?? []) as any[]).filter((v) => viewNames.has(v.view));
  const box = (table: string, x: number, y: number, isLeft: boolean) => {
    const t = tables.find((x2) => x2.table === table);
    const mine = areaLinks.filter((l) => l.from === table || l.to === table);
    const on = sel ? sel.from === table || sel.to === table : false;
    return (
      <div key={`${isLeft ? "l" : "r"}${table}`} className={cn("vd-box", isLeft && "is-fact", on && "is-on")} style={{ left: x, top: y, width: BOX_W, height: BOX_H }} title={t?.comment || table}>
        <b>{nameOf(table)}</b>
        <small>
          {isLeft ? (t?.measures ? `${fmt.plural(t.measures, "measure")} · ` : "") : ""}
          {fmt.plural(mine.length, "link")}
          {areaOf(table) !== area ? ` · ${AREA_LABEL[areaOf(table)].toLowerCase()}` : ""}
        </small>
      </div>
    );
  };

  return (
    <Section
      id="rv-view-diagram"
      icon="network"
      title="How the customer's tables connect"
      point="The tables behind each area and the links between them. Pick an area. A line is a link: this table finds its match in that one. Wrong or missing? Change it here, and Mapping follows."
      tools={cards && <GroupBar gid="g:links" ctx={cards} />}
    >
      <div className="vd-tabs" role="tablist" aria-label="Area">
        {present.map((a) => {
          const n = links.filter((l) => areaOf(l.from) === a).length;
          const lost = tables.filter((t) => areaOf(t.table) === a && !linked.has(t.table)).length;
          return (
            <button key={a} type="button" role="tab" aria-selected={a === area} className={cn("vd-tab", a === area && "is-on")} onClick={() => { setArea(a); setPicked(null); }}>
              {AREA_LABEL[a]}
              <small>
                {fmt.plural(n, "link")}
                {lost > 0 && <em> · {lost} not linked</em>}
              </small>
            </button>
          );
        })}
      </div>

      {areaLinks.length === 0 ? (
        <p className="stage-helper">No links in this area. {tables.some((t) => areaOf(t.table) === area) ? "Its tables are listed below." : "No tables either."}</p>
      ) : (
        <div className="vd-scroll">
          <div className="vd-canvas" style={{ width: WIDTH, height }}>
            <svg width={WIDTH} height={height} viewBox={`0 0 ${WIDTH} ${height}`} aria-hidden>
              {wires.map(({ l, d }) => (
                <g key={l.id} className={cn("vd-wire", l.id === sel?.id && "is-on", l.source === "team" && "is-team")}>
                  <path d={d} />
                  <path d={d} className="vd-hit" onClick={() => setPicked(l.id)} />
                </g>
              ))}
            </svg>
            {left.map((t) => box(t, PAD, topOf("l", t), true))}
            {right.map((t) => box(t, PAD + BOX_W + MID, topOf("r", t), false))}
          </div>
        </div>
      )}

      {sel && (
        <article className={cn("rv-item rv-join card-hover", cards?.unlocked.has(sel.id) && "is-open")} aria-label="The chosen link">
          <div className="rv-item-head">
            <strong>
              {nameOf(sel.from)} <Icon name="arrow-right" size={14} /> {nameOf(sel.to)}
            </strong>
            <Status tone={sel.source === "team" ? "info" : "ready"}>{sel.source === "team" ? "Added or changed by our team" : "Declared in the customer's view"}</Status>
          </div>
          <Lines
            rows={[
              ["In plain words", `Each ${nameOf(sel.from).toLowerCase()} row finds its match in ${nameOf(sel.to).toLowerCase()} using ${sel.keys === sel.ref ? sel.keys : `${sel.keys} on the first and ${sel.ref} on the second`}.`],
              ["Our team's reason", sel.note ? sel.note : null],
              ["Mapping uses it", "Yes. Remove or change it here and the next mapping run reads the change."],
            ]}
          />
          {cards && <CardBar id={sel.id} ctx={cards} join />}
          {cards?.editing === sel.id && <CardEditor key={sel.id} id={sel.id} kind="link" item={sel.raw} ctx={cards} />}
        </article>
      )}

      {areaLinks.length > 0 && (
        <div className="rv-block">
          <Sub title="Links in this area" note={`${areaLinks.length} · click a line in the picture, or pick one here`} tools={cards && <GroupBar gid={`g:links:${area}`} ctx={cards} />} />
          <Fold title={`Show the ${areaLinks.length} links as a list`}>
            <ul className="vd-list">
              {areaLinks.map((l) => (
                <li key={l.id}>
                  <button type="button" className={cn("vd-row", l.id === sel?.id && "is-on")} onClick={() => setPicked(l.id)}>
                    <span className="vd-ends">
                      <b>{nameOf(l.from)}</b> <Icon name="arrow-right" size={13} /> <b>{nameOf(l.to)}</b>
                    </span>
                    <code>{l.keys === l.ref ? l.keys : `${l.keys} = ${l.ref}`}</code>
                    {l.source === "team" && <Status tone="info">Our team</Status>}
                    {cards?.unlocked.has(l.id) && <Status tone="decide">Open for changes</Status>}
                  </button>
                </li>
              ))}
            </ul>
          </Fold>
        </div>
      )}

      {unlinked.length > 0 && (
        <div className="rv-block vd-unlinked">
          <Sub title="Tables with no link" note="nothing connects these, so nothing can be joined to them" />
          <ul className="vd-list">
            {unlinked.map((t) => (
              <li key={t.table} className="vd-nolink">
                <Status tone="partial">No link</Status>
                <span>
                  <b>{nameOf(t.table)}</b>
                  {t.comment && <small className="rv-muted"> {humanDates(t.comment)}</small>}
                </span>
              </li>
            ))}
          </ul>
          <p className="stage-helper">If one of these should connect, add the link below. If not, it is fine to leave it.</p>
        </div>
      )}

      {cards && <AddLink ctx={cards} disabled={cards.busy} />}

      <div className="rv-block">
        <Sub title="How the AI reads this area" note="written by the AI, check it" tools={cards && <GroupBar gid={`g:coverage:${area}`} ctx={cards} />} />
        {coverage.length === 0 && reads.length === 0 ? (
          <p className="stage-helper">The AI wrote nothing about this area.</p>
        ) : (
          <>
            {coverage.map((c) => {
              const s = COVERAGE[c.status] ?? COVERAGE.missing;
              return (
                <p key={c.family} className="vd-ai">
                  <Status tone={s.tone}>{s.word}</Status> <b>{c.family.replace(/_/g, " ")}</b> {humanDates(c.evidence)}
                </p>
              );
            })}
            {reads.map((v) => (
              <Lines
                key={v.view}
                rows={[
                  ["The AI reads the view as", humanDates(v.purpose)],
                  ["One row is", humanDates(v.grain)],
                  ["Cannot answer", (v.caveats ?? []).length ? (v.caveats as string[]).map(humanDates).join(" ") : null],
                ]}
              />
            ))}
          </>
        )}
      </div>
    </Section>
  );
}
