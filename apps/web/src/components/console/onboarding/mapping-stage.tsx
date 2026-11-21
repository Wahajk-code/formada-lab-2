"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";

import { askWorkspaceAI, confirmMappingLink, editProposalItem, reviseProposalItem } from "@/app/console-actions";
import { ChatJump } from "@/components/console/onboarding/chat-jump";
import type { AssistantTurn } from "@/lib/client-api";
import { EngineerChat } from "@/components/console/onboarding/engineer-chat";
import { appendTurns, truncateTurns, useChatTurns } from "@/lib/chat-store";
import { FieldFlow, WORDS } from "@/components/console/onboarding/mapping-guide";
import { Icon, type IconName } from "@/components/ui/icon";
import type { OnboardingGuide, OnboardingStep } from "@/lib/console-api";

type Filter = "All" | "Confirmed" | "Needs review";
const integer = new Intl.NumberFormat("en-CA");
const FILTERS: Filter[] = ["All", "Confirmed", "Needs review"];
const short = (t: string) => t.split(".").pop() ?? t;

function Badge({ kind = "neutral", icon, children }: { kind?: "neutral" | "positive" | "attention" | "accent"; icon?: IconName; children: React.ReactNode }) {
  return (
    <span className={`stage-badge ${kind}`}>
      {icon && <Icon name={icon} size={13} />}
      {children}
    </span>
  );
}

function PanelTitle({ title, description, icon }: { title: string; description: string; icon: IconName }) {
  return (
    <div className="stage-panel-heading">
      <span className="stage-heading-icon">
        <Icon name={icon} size={19} />
      </span>
      <div>
        <h3>{title}</h3>
        <p>{description}</p>
      </div>
    </div>
  );
}

/** Their tables behind one link, the one that feeds most fields first. */
function sources(a: any): string[] {
  const count = new Map<string, number>();
  for (const f of a.fields ?? [])
    for (const c of f.source_columns ?? []) {
      const t = String(c).split(".").slice(0, -1).join(".");
      if (t) count.set(t, (count.get(t) ?? 0) + 1);
    }
  return [...count.entries()].sort((x, y) => y[1] - x[1]).map(([t]) => t);
}

function confidenceOf(a: any): string {
  const used = (a.fields ?? []).filter((f: any) => f.source_columns?.length);
  if (!used.length) return "No source";
  if (used.some((f: any) => f.confidence === "low")) return "Low confidence";
  if (used.every((f: any) => f.confidence === "high")) return "High confidence";
  return "Medium confidence";
}

type Link = { a: any; check: any; ok: boolean; confirmed: boolean; unmappable: boolean };

export function MappingStage({
  step,
  guide,
  workspaceId,
  can,
}: {
  step: OnboardingStep;
  guide: OnboardingGuide | null;
  workspaceId: string;
  can: boolean;
}) {
  const router = useRouter();
  const out = step.output as any;
  const checks = (step.checks?.archetypes ?? {}) as Record<string, any>;
  const confirmedKeys: string[] = out.confirmed ?? [];
  // Once the team has completed the step, the links it kept count as confirmed.
  const approved = step.status === "approved";
  const metas = Object.fromEntries((guide?.archetypes ?? []).map((a) => [a.archetype, a]));
  const links: Link[] = (out.archetypes as any[]).map((a) => {
    const check = checks[a.archetype] ?? {};
    const unmappable = a.status === "unmappable";
    return { a, check, ok: !unmappable && Boolean(check.ok), confirmed: approved || confirmedKeys.includes(a.archetype), unmappable };
  });
  // Links that pass their live test are the ones the calculations use; those are confirmed one by one.
  const reviewable = links.filter((l) => l.ok);
  const confirmed = reviewable.filter((l) => l.confirmed).length;
  const pending = reviewable.length - confirmed;
  const percent = Math.round((confirmed / (reviewable.length || 1)) * 100);

  const [filter, setFilter] = useState<Filter>("All");
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { turns, clear } = useChatTurns(workspaceId, "mapping");
  const [thinking, setThinking] = useState(false);
  const [busy, start] = useTransition();
  const [note, setNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [instruction, setInstruction] = useState<Record<string, string>>({});
  const [sql, setSql] = useState<Record<string, string>>(() => Object.fromEntries((out.archetypes as any[]).map((a) => [a.archetype, a.source_sql])));
  const list = useRef<HTMLDivElement>(null);

  const visible = links.filter((l) => (filter === "All" ? true : filter === "Confirmed" ? l.confirmed : !l.confirmed && !l.unmappable));

  const ask = (text: string, earlier?: AssistantTurn[]) => {
    const history = earlier ?? turns;
    appendTurns(workspaceId, "mapping", { role: "user", text, intent: "ask" });
    setThinking(true);
    start(async () => {
      const res = await askWorkspaceAI(workspaceId, "mapping", text, history);
      if (res.ok && res.data) {
        const { answer, sources: src, grounded, unverified } = res.data;
        appendTurns(workspaceId, "mapping", { role: "assistant", text: answer, check: { sources: src, grounded, unverified } });
      } else appendTurns(workspaceId, "mapping", { role: "assistant", text: res.ok ? "No answer." : res.error });
      setThinking(false);
    });
  };

  // Edit a question in place: ask it again from that message on, and clear what came after it.
  const resend = (index: number, text: string) => {
    const history = turns.slice(0, index);
    truncateTurns(workspaceId, "mapping", index);
    ask(text, history);
  };

  const saved = (key: string, res: { ok: boolean; error?: string; data?: any }, ok: string) => {
    if (!res.ok) return setNote((n) => ({ ...n, [key]: { ok: false, text: res.error ?? "Failed" } }));
    const d = res.data;
    const extra = [...(d?.errors ?? []).map((e: string) => `Error: ${e}`), ...(d?.warnings ?? []).map((w: string) => `Note: ${w}`)];
    setNote((n) => ({ ...n, [key]: { ok: !d?.errors?.length, text: `${ok}${extra.length ? " " + extra.slice(0, 2).join(" ") : ""}` } }));
    router.refresh();
  };

  const nextToReview = () => {
    const next = reviewable.find((l) => !l.confirmed);
    if (!next) return;
    setFilter("All");
    setOpenKey(next.a.archetype);
    requestAnimationFrame(() => list.current?.querySelector(`[data-link="${next.a.archetype}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" }));
  };

  return (
    <>
      <section className="stage-panel stage-content-panel mapping-progress">
        <PanelTitle
          title="Mapping progress"
          description={pending ? "Review the remaining links before starting the Org Web." : "The confirmed mappings are ready to use in the metric catalog."}
          icon="network"
        />
        <div className="mapping-meter">
          <div className="mapping-meter-top">
            <span>
              <strong>{confirmed}</strong> of {reviewable.length} mappings confirmed
            </span>
            <b className="stage-mono">{percent}%</b>
          </div>
          <div
            className="mapping-segments"
            role="progressbar"
            aria-label="Confirmed mappings"
            aria-valuemin={0}
            aria-valuemax={reviewable.length || 1}
            aria-valuenow={confirmed}
            aria-valuetext={`${confirmed} confirmed, ${pending} need review`}
          >
            {reviewable.map((l, i) => (
              <span key={l.a.archetype} className={i < confirmed ? "is-confirmed" : ""} />
            ))}
          </div>
          <div className="mapping-meter-foot">
            <div className="mapping-legend">
              <span>
                <i />
                {confirmed} confirmed
              </span>
              <span>
                <i />
                {pending} to review
              </span>
            </div>
            {pending ? (
              <button type="button" className="stage-inline-link" onClick={nextToReview}>
                View next mapping <Icon name="arrow-right" size={15} />
              </button>
            ) : (
              <Badge kind="positive" icon="check">
                All mappings confirmed
              </Badge>
            )}
          </div>
        </div>
      </section>

      <div data-engineer-chat-host>
        <EngineerChat
          scope="Mapping"
          turns={turns}
          pending=""
          thinking={thinking}
          emptyTitle="What would you like to review?"
          intro="Ask about a link, its confidence, or what to review next."
          placeholder="Ask about a mapping…"
          starters={["Which mappings need review?", `Explain ${WORDS[reviewable[0]?.a.archetype] ?? "the first link"}`]}
          onAsk={ask}
          onClear={clear}
          onResend={resend}
        />
      </div>
      <ChatJump />

      <section className="stage-panel stage-content-panel">
        <PanelTitle title="Mapping review" description="Compare each of their tables with the shape it feeds in the Formada standard model." icon="network" />
        <div className="stage-filters" aria-label="Filter results">
          {FILTERS.map((v) => (
            <button key={v} type="button" aria-pressed={filter === v} className={`stage-filter${filter === v ? " selected" : ""}`} onClick={() => setFilter(v)}>
              {v}
            </button>
          ))}
        </div>
        <div className="stage-mapping-list" ref={list}>
          {visible.length ? (
            visible.map(({ a, check, ok, confirmed: done, unmappable }) => {
              const key = a.archetype;
              const meta = metas[key];
              const fills = Object.fromEntries((check.fills ?? []).map((x: any) => [x.field, x.fill_pct]));
              const meanings = Object.fromEntries((meta?.fields ?? []).map((f) => [f.field, f.meaning]));
              const from = sources(a);
              return (
                <details
                  key={key}
                  data-link={key}
                  className="stage-disclosure stage-map-row"
                  data-confirmed={done}
                  open={openKey === key}
                  onToggle={(e) => {
                    const o = (e.currentTarget as HTMLDetailsElement).open;
                    setOpenKey((cur) => (o ? key : cur === key ? null : cur));
                  }}
                >
                  <summary>
                    <span className="stage-map-source">
                      <small>{unmappable ? "Their data" : `${from.length} ${from.length === 1 ? "table" : "tables"}`}</small>
                      <code>{unmappable ? "Not in their data" : from.length ? `${short(from[0])}${from.length > 1 ? ` +${from.length - 1}` : ""}` : "Their tables"}</code>
                    </span>
                    <span className="stage-map-arrow">
                      <Icon name="arrow-right" size={17} />
                    </span>
                    <span className="stage-map-source stage-map-target">
                      <small>Formada standard model</small>
                      <code>{key}</code>
                    </span>
                    <span className="stage-map-state">
                      {unmappable ? (
                        <Badge>Not in their data</Badge>
                      ) : !ok ? (
                        <Badge kind="attention">Fails the live test</Badge>
                      ) : (
                        <Badge kind={done ? "positive" : "attention"}>{done ? "Confirmed" : "Needs review"}</Badge>
                      )}
                      <small>{unmappable ? "No source" : confidenceOf(a)}</small>
                    </span>
                    <Icon name="chevron-down" size={15} />
                  </summary>
                  <div className="stage-map-detail">
                    <div>
                      <strong>{WORDS[key] ?? key}</strong>
                      <p>
                        {meta?.description ?? ""}
                        {unmappable ? ` ${a.questions?.[0] ?? "Their warehouse has no source for this, so cards that need it stay off."}` : ""}
                      </p>
                    </div>
                    {can && ok && !done && (
                      <button
                        type="button"
                        className="btn btn-primary"
                        disabled={busy}
                        onClick={() => start(async () => saved(key, await confirmMappingLink(workspaceId, step.id, key), "Confirmed. This link is kept if the analysis runs again."))}
                      >
                        <Icon name="check" size={17} />
                        <span>Confirm mapping</span>
                      </button>
                    )}
                  </div>
                  {!unmappable && (
                    <div className="space-y-3 px-1 pb-2">
                      <div className="flex flex-wrap gap-2">
                        <Badge kind={check.rows ? "positive" : "attention"}>{integer.format(check.rows ?? 0)} rows</Badge>
                        {check.first_date && (
                          <Badge>
                            {check.first_date} to {check.last_date}
                          </Badge>
                        )}
                        {check.dates != null && <Badge>{integer.format(check.dates)} dates</Badge>}
                      </div>
                      {(check.errors ?? []).map((e: string) => (
                        <p key={e} className="stage-badge attention">
                          {e}
                        </p>
                      ))}
                      {(check.warnings ?? []).map((w: string) => (
                        <p key={w} className="stage-helper">
                          {w}
                        </p>
                      ))}
                      <FieldFlow a={a} fills={fills} meanings={meanings} />
                      {a.filters?.length > 0 && (
                        <div>
                          <p className="eyebrow">Rules applied to their rows</p>
                          <ul className="list-disc pl-5 text-sm">
                            {a.filters.map((f: string, i: number) => (
                              <li key={i}>{f}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {a.questions?.length > 0 && (
                        <ul className="list-disc pl-5 text-xs text-muted-foreground">
                          {a.questions.map((q: string, i: number) => (
                            <li key={i}>{q}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )}
                  {can && !unmappable && (
                    <form
                      className="stage-form stage-metric-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const text = (instruction[key] ?? "").trim();
                        if (!text) return;
                        start(async () => {
                          saved(key, await reviseProposalItem(workspaceId, "mapping", step.id, key, text), "Changed by AI as a new proposal; only this link changed and it needs a new confirmation.");
                          setInstruction((s) => ({ ...s, [key]: "" }));
                        });
                      }}
                    >
                      <label>
                        Ask the AI to change this link
                        <input
                          value={instruction[key] ?? ""}
                          maxLength={2000}
                          placeholder="e.g. also exclude locations whose name starts with Legacy"
                          onChange={(e) => setInstruction((s) => ({ ...s, [key]: e.target.value }))}
                        />
                      </label>
                      <details>
                        <summary className="stage-inline-link">The query (read-only on their warehouse)</summary>
                        <textarea
                          className="mt-2 w-full rounded-lg border border-border bg-surface p-3 font-mono text-[11px] leading-relaxed"
                          rows={Math.min(18, (sql[key] ?? "").split("\n").length + 1)}
                          spellCheck={false}
                          value={sql[key] ?? ""}
                          onChange={(e) => setSql((s) => ({ ...s, [key]: e.target.value }))}
                        />
                        <button
                          type="button"
                          className="btn btn-secondary mt-2"
                          disabled={busy || sql[key] === a.source_sql}
                          onClick={() =>
                            start(async () =>
                              saved(key, await editProposalItem(workspaceId, "mapping", step.id, key, { ...a, source_sql: sql[key] }), "Query saved and re-run on their warehouse for this link only."),
                            )
                          }
                        >
                          <Icon name="refresh" size={17} />
                          <span>Save and re-check this link</span>
                        </button>
                      </details>
                      {note[key] && (
                        <p className="metric-form-error" role="status" style={{ color: note[key].ok ? undefined : undefined }}>
                          {note[key].text}
                        </p>
                      )}
                      <div className="stage-form-footer">
                        <button type="submit" className="btn btn-secondary" disabled={busy || !(instruction[key] ?? "").trim()}>
                          <Icon name="sparkles" size={17} />
                          <span>Change this link</span>
                        </button>
                      </div>
                    </form>
                  )}
                </details>
              );
            })
          ) : (
            <p className="stage-table-empty">No mappings in this view.</p>
          )}
        </div>
      </section>
    </>
  );
}
