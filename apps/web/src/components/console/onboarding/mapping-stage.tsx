"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";

import { askWorkspaceAI, confirmMappingLink, editProposalItem, reviseProposalItem } from "@/app/console-actions";
import { ChatJump } from "@/components/console/onboarding/chat-jump";
import { EngineerChat } from "@/components/console/onboarding/engineer-chat";
import { WORDS } from "@/components/console/onboarding/mapping-guide";
import { breakable, FactBar, fmt, Fold, humanDates, humanName, Lines, Section, shortName, Status, Sub, type Tone } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import { appendTurns, truncateTurns, useChatTurns } from "@/lib/chat-store";
import { contextOf, idsToSend, missingNote, questionWithMentions } from "@/lib/mentions";
import type { AssistantTurn } from "@/lib/client-api";
import type { OnboardingGuide, OnboardingStep } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/**
 * Mapping review (docs/review-format.md): what each standard shape reads from their warehouse.
 * Answer first (one tile per shape), then one card per shape: its status, where it reads from,
 * the decisions it needs, the rules it applies, then every field. The query is folded. Links and
 * fields can be given to the chat with @.
 */

type Filter = "All" | "Needs review" | "Confirmed";
const FILTERS: Filter[] = ["All", "Needs review", "Confirmed"];
type Link = { a: any; check: any; ok: boolean; confirmed: boolean; unmappable: boolean; labOnly: boolean };

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

/** The view a link reads through, from its query: semantic_view(DB.SCHEMA.VIEW ...). */
const viewOf = (sql: string) => /semantic_view\s*\(\s*([\w.$"]+)/i.exec(sql ?? "")?.[1]?.replace(/"/g, "");
/** Tables named in FROM / JOIN of a query (for a link that reads tables directly). */
const tablesOf = (sql: string) => [...new Set([...(sql ?? "").matchAll(/\b(?:from|join)\s+([\w.$"]+)/gi)].map((m) => m[1].replace(/"/g, "")).filter((t) => !/^semantic_view$/i.test(t) && t.includes(".")))];

function status(l: Link): { tone: Tone; word: string } {
  if (l.unmappable) return { tone: "missing", word: "Not in their data" };
  if (!l.ok) return { tone: "fail", word: "Fails the check" };
  if (l.confirmed) return { tone: "ready", word: "Confirmed" };
  if (l.a.status === "partial" || (l.a.questions ?? []).length) return { tone: "decide", word: "Needs a decision" };
  return { tone: "partial", word: "Ready to confirm" };
}

const firstSentence = (s: string) => s.split(/(?<=\.)\s/)[0] ?? s;
const CONF: Record<string, Tone> = { high: "ready", medium: "partial", low: "fail" };

export function MappingStage({ step, guide, workspaceId, can }: { step: OnboardingStep; guide: OnboardingGuide | null; workspaceId: string; can: boolean }) {
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
    return { a, check, ok: !unmappable && Boolean(check.ok), confirmed: approved || confirmedKeys.includes(a.archetype), unmappable, labOnly: Boolean(check.lab_not_run) };
  });
  // Links that pass their live test are the ones the calculations use; those are confirmed one by one.
  const reviewable = links.filter((l) => l.ok);
  const confirmed = reviewable.filter((l) => l.confirmed).length;
  const pending = reviewable.length - confirmed;
  const percent = Math.round((confirmed / (reviewable.length || 1)) * 100);

  const [filter, setFilter] = useState<Filter>("All");
  const { turns, clear } = useChatTurns(workspaceId);
  const [thinking, setThinking] = useState(false);
  const [busy, start] = useTransition();
  const [note, setNote] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [instruction, setInstruction] = useState<Record<string, string>>({});
  const [sql, setSql] = useState<Record<string, string>>(() => Object.fromEntries((out.archetypes as any[]).map((a) => [a.archetype, a.source_sql])));
  const [mentioned, setMentioned] = useState<string[]>([]);
  // Attachments the person removed from the conversation's context.
  const [dropped, setDropped] = useState<string[]>([]);
  const context = useMemo(() => contextOf(turns, dropped), [turns, dropped]);
  const list = useRef<HTMLDivElement>(null);

  const visible = links.filter((l) => (filter === "All" ? true : filter === "Confirmed" ? l.confirmed : !l.confirmed && !l.unmappable));
  const mentionables = useMemo(
    () =>
      (out.archetypes as any[]).flatMap((a) => [
        { id: `m:${a.archetype}`, label: WORDS[a.archetype] ?? a.archetype, kind: "link", locked: false, note: "Given to the chat as context" },
        ...(a.fields ?? []).map((f: any) => ({ id: `m:${a.archetype}.${f.field}`, label: `${WORDS[a.archetype] ?? a.archetype}: ${f.field}`, kind: "field", locked: false, note: "Given to the chat as context" })),
      ]),
    [out.archetypes],
  );
  const mentions = mentioned.filter((id) => mentionables.some((m) => m.id === id));
  const at = { mentioned: new Set(mentions), onMention: (id: string) => setMentioned((cur) => (cur.includes(id) || cur.length >= 8 ? cur : [...cur, id])) };

  // One conversation for the whole onboarding: each message remembers the page it was written on.
  const SCOPE = "Mapping";
  const push = (...more: AssistantTurn[]) => appendTurns(workspaceId, SCOPE, ...more);
  const labelFor = (id: string) => mentionables.find((m) => m.id === id)?.label ?? context.find((c) => c.id === id)?.label;
  const attachedOf = (ids: string[]) => ids.map((id) => ({ id, label: labelFor(id) ?? id }));

  const ask = (text: string, earlier?: { history: AssistantTurn[]; cards: string[]; attached: { id: string; label: string }[] }) => {
    const history = earlier?.history ?? turns;
    const fresh = earlier?.attached ?? attachedOf(mentions);
    // The new attachments move onto this message; what was attached before stays in context.
    const cards = earlier?.cards ?? idsToSend(fresh.map((a) => a.id), context);
    setDropped((d) => d.filter((x) => !fresh.some((a) => a.id === x)));
    push({ role: "user", text, intent: "ask", cards, attached: fresh });
    setThinking(true);
    start(async () => {
      const res = await askWorkspaceAI(workspaceId, "mapping", questionWithMentions(text, cards, labelFor), history, cards);
      if (res.ok && res.data) {
        const { answer, sources: src, grounded, unverified } = res.data;
        const note = missingNote(cards, res.data.mentions_missing, labelFor);
        push({ role: "assistant", text: note ? `${answer}\n\n${note}` : answer, check: { sources: src, grounded, unverified } });
      } else push({ role: "assistant", text: res.ok ? "No answer." : res.error });
      setThinking(false);
    });
  };

  // "/change ...": the AI is authorised to change the link, whatever it thinks of the change. It acts
  // on the links and fields attached to this message, else on what is still in the context. The
  // change is a new proposal, so the link needs a new confirmation.
  const change = (text: string) => {
    const named = mentions.length ? mentions : context.map((c) => c.id);
    const mine = named.filter((id) => id.startsWith("m:"));
    const say = (reply: string) => push({ role: "user", text: `/change ${text}`.trim(), intent: "revise", attached: attachedOf(named) }, { role: "assistant", text: reply });
    if (!text) return say("Say what should change after /change, for example: /change use invoiced sales instead of placed.");
    if (!mine.length) return say("Attach the link or the field you want changed with @, then start again with /change.");
    const shapes = [...new Set(mine.map((id) => id.slice(2).split(".")[0]))].slice(0, 2);
    const fields = mine.filter((id) => id.includes(".")).map((id) => id.slice(2).split(".")[1]);
    const instruction = fields.length ? `About the field${fields.length > 1 ? "s" : ""} ${fields.join(", ")}: ${text}` : text;
    setThinking(true);
    start(async () => {
      const done: string[] = [];
      let failed: string | null = null;
      for (const shape of shapes) {
        const res = await reviseProposalItem(workspaceId, "mapping", step.id, shape, instruction);
        if (!res.ok) {
          failed = res.error ?? "Failed";
          break;
        }
        const d = res.data as any;
        const notes = [...(d?.errors ?? []).map((e: string) => `Error: ${e}`), ...(d?.warnings ?? []).map((w: string) => `Note: ${w}`)].slice(0, 2);
        done.push(`${WORDS[shape] ?? shape}${notes.length ? ` (${notes.join(" ")})` : ""}`);
      }
      push(
        { role: "user", text: `/change ${text}`, intent: "revise", cards: mine, attached: attachedOf(named) },
        { role: "assistant", text: failed ? failed : `Changed ${done.join(" and ")} as a new proposal. Only ${done.length === 1 ? "this link" : "these links"} changed, and ${done.length === 1 ? "it needs" : "they need"} a new confirmation.` },
      );
      setThinking(false);
      router.refresh();
    });
  };

  // Edit a question in place: ask it again from that message on, and clear what came after it.
  const resend = (index: number, text: string) => {
    const history = turns.slice(0, index);
    const cards = turns[index]?.cards ?? [];
    truncateTurns(workspaceId, SCOPE, index);
    ask(text, { history, cards, attached: turns[index]?.attached ?? [] });
  };

  const saved = (key: string, res: { ok: boolean; error?: string; data?: any }, ok: string) => {
    if (!res.ok) return setNote((n) => ({ ...n, [key]: { ok: false, text: res.error ?? "Failed" } }));
    const d = res.data;
    const extra = [...(d?.errors ?? []).map((e: string) => `Error: ${e}`), ...(d?.warnings ?? []).map((w: string) => `Note: ${w}`)];
    setNote((n) => ({ ...n, [key]: { ok: !d?.errors?.length, text: `${ok}${extra.length ? " " + extra.slice(0, 2).join(" ") : ""}` } }));
    router.refresh();
  };

  const jump = (key: string) => {
    setFilter("All");
    requestAnimationFrame(() => list.current?.querySelector(`[data-link="${key}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }));
  };
  const nextToReview = () => {
    const next = reviewable.find((l) => !l.confirmed);
    if (next) jump(next.a.archetype);
  };

  return (
    <>
      <section className="stage-panel stage-content-panel">
        <div className="rv">
          <section className="rv-summary" aria-labelledby="mp-summary">
            <p className="rv-eyebrow">
              <Icon name="network" size={14} /> Summary · links between their data and our standard shapes
            </p>
            <h4 id="mp-summary">
              {reviewable.length} of {links.length} shapes have a working source
            </h4>
            <p className="rv-muted">
              Each shape is one read-only query on their warehouse. Our tested calculations read only these shapes, so every metric works the same way for every customer. Confirm each link once its
              decisions are answered.
            </p>
            <div className="mapping-meter">
              <div className="mapping-meter-top">
                <span>
                  <strong>{confirmed}</strong> of {reviewable.length} confirmed
                </span>
                <b className="stage-mono">{percent}%</b>
              </div>
              <div className="mapping-segments" role="progressbar" aria-label="Confirmed mappings" aria-valuemin={0} aria-valuemax={reviewable.length || 1} aria-valuenow={confirmed} aria-valuetext={`${confirmed} confirmed, ${pending} to review`}>
                {reviewable.map((l, i) => (
                  <span key={l.a.archetype} className={i < confirmed ? "is-confirmed" : ""} />
                ))}
              </div>
              <div className="mapping-meter-foot">
                <span className="rv-muted">{pending ? `${pending} to review` : "All confirmed"}</span>
                {pending > 0 && (
                  <button type="button" className="stage-inline-link" onClick={nextToReview}>
                    Next to review <Icon name="arrow-right" size={15} />
                  </button>
                )}
              </div>
            </div>
          </section>

          <Section icon="target" title="Shapes at a glance" point="What each standard shape reads from, and what it still needs. Open a shape for its fields.">
            <div className="rv-tiles">
              {links.map((l) => {
                const st = status(l);
                const view = viewOf(l.a.source_sql);
                const from = view ? [view] : tablesOf(l.a.source_sql).length ? tablesOf(l.a.source_sql) : sources(l.a);
                const found = (l.a.fields ?? []).filter((f: any) => f.source_columns?.length).length;
                return (
                  <button key={l.a.archetype} type="button" className={cn("rv-tile", `rv-tile-${st.tone === "ready" ? "ready" : st.tone === "missing" ? "missing" : "partial"}`)} onClick={() => jump(l.a.archetype)}>
                    <span className="rv-tile-top">
                      <b>{WORDS[l.a.archetype] ?? humanName(l.a.archetype)}</b>
                      <Status tone={st.tone}>{st.word}</Status>
                    </span>
                    <span className="rv-tile-line">
                      {l.unmappable ? (
                        l.a.questions?.[0] ? humanDates(l.a.questions[0]) : "No source in their data."
                      ) : from.length ? (
                        <>
                          {view ? "Through the view " : "From "}
                          {breakable(from.map(shortName).slice(0, 2).join(", "))}
                          {from.length > 2 ? ` +${from.length - 2}` : ""}
                        </>
                      ) : (
                        "Their tables"
                      )}
                    </span>
                    {!l.unmappable && (
                      <span className="rv-tile-foot">
                        {found} of {(l.a.fields ?? []).length} fields found
                        {(l.a.questions ?? []).length > 0 && ` · ${fmt.plural(l.a.questions.length, "decision")}`}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </Section>
        </div>
      </section>


      <section className="stage-panel stage-content-panel">
        <div className="rv" ref={list}>
          <div className="stage-filters" aria-label="Filter shapes">
            {FILTERS.map((v) => (
              <button key={v} type="button" aria-pressed={filter === v} className={`stage-filter${filter === v ? " selected" : ""}`} onClick={() => setFilter(v)}>
                {v}
              </button>
            ))}
          </div>
          {visible.length === 0 && <p className="stage-table-empty">No shapes in this view.</p>}
          {visible.map((l) => {
            const { a, check, ok, confirmed: done, unmappable } = l;
            const key = a.archetype;
            const meta = metas[key];
            const st = status(l);
            const fills: Record<string, number> = Object.fromEntries((check.fills ?? []).map((x: any) => [x.field, x.fill_pct]));
            const meanings: Record<string, string> = Object.fromEntries((meta?.fields ?? []).map((f) => [f.field, f.meaning]));
            const view = viewOf(a.source_sql);
            const tables = tablesOf(a.source_sql);
            const fields: any[] = a.fields ?? [];
            const found = fields.filter((f) => f.source_columns?.length);
            const missing = fields.filter((f) => !f.source_columns?.length);
            return (
              <div key={key} data-link={key} className="rv-link-anchor">
                <Section
                  className="rv-area"
                  title={WORDS[key] ?? humanName(key)}
                  count={<Status tone={st.tone}>{st.word}</Status>}
                  point={meta?.description ? firstSentence(meta.description) : undefined}
                  tools={<FactBar id={`m:${key}`} ctx={at} note={null} />}
                >
                  <Lines
                    rows={[
                      ["Standard shape", <code key="k">{key}</code>],
                      ["About it", meta?.description && firstSentence(meta.description) !== meta.description ? <span className="rv-muted">{meta.description.slice(firstSentence(meta.description).length).trim()}</span> : null],
                      ["Reads from", unmappable ? "Nothing: their warehouse has no source for this" : view ? <>The customer&apos;s view <code>{view}</code></> : tables.length ? <code>{tables.join(", ")}</code> : sources(a).map(shortName).join(", ")],
                      [
                        "Rows",
                        unmappable ? null : l.labOnly ? (
                          <span className="rv-muted">Not run in the review lab: the query runs on their warehouse in production.</span>
                        ) : check.rows != null ? (
                          <>
                            {fmt.count(check.rows)} rows{check.first_date ? ` · ${fmt.range(check.first_date, check.last_date, true)}` : ""}
                            {check.dates != null ? ` · ${fmt.plural(check.dates, "date")}` : ""}
                          </>
                        ) : null,
                      ],
                      ["Fields", unmappable ? null : `${found.length} of ${fields.length} found${missing.length ? ` · ${missing.length} not in their data` : ""}`],
                    ]}
                  />

                  {(check.errors ?? []).length > 0 && (
                    <div className="rv-alert rv-alert-fail">
                      <b>The check failed</b>
                      <ul className="rv-list">
                        {(check.errors as string[]).map((e) => (
                          <li key={e}>{e}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(a.questions ?? []).length > 0 && (
                    <div className="rv-block">
                      <Sub title={unmappable ? "What we would need" : "Decisions needed"} note={unmappable ? undefined : "answer before confirming"} />
                      <ul className="rv-decisions">
                        {(a.questions as string[]).map((q) => (
                          <li key={q}>
                            <Icon name="circle-help" size={15} />
                            <span>{humanDates(q)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(a.filters ?? []).length > 0 && (
                    <div className="rv-block">
                      <Sub title="Rules applied to their rows" />
                      <ul className="rv-rules">
                        {(a.filters as string[]).map((f) => (
                          <li key={f}>{humanDates(f)}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {(check.warnings ?? []).length > 0 && (
                    <div className="rv-alert">
                      <b>Notes from the check</b>
                      <ul className="rv-list">
                        {(check.warnings as string[]).map((w) => (
                          <li key={w}>{w}</li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {fields.length > 0 && (
                    <div className="rv-block">
                      <Sub title="Field by field" note="our field ← their column" />
                      <div className="rv-fields" role="table" aria-label={`${WORDS[key] ?? key} fields`}>
                        <div className="rv-fr rv-th" role="row">
                          <span role="columnheader">Our field</span>
                          <span role="columnheader">Their column</span>
                          <span role="columnheader">How</span>
                          <span role="columnheader">Confidence</span>
                        </div>
                        {[...found, ...missing].map((f) => {
                          const has = f.source_columns?.length > 0;
                          return (
                            <div key={f.field} className={cn("rv-fr card-hover", !has && "rv-fr-missing")} role="row" title={f.reason}>
                              <span role="cell">
                                <code className="rv-ours">{f.field}</code>
                                {meanings[f.field] && <small className="rv-muted">{meanings[f.field]}</small>}
                              </span>
                              <span role="cell">{has ? <code>{(f.source_columns as string[]).join(" + ")}</code> : <span className="rv-muted">Not in their data</span>}</span>
                              <span role="cell">
                                {has ? humanDates(f.expression) : <span className="rv-muted">Left empty</span>}
                                {fills[f.field] != null && (
                                  <span className={cn("rv-fill", fills[f.field] < 50 && "low")}>
                                    <i style={{ ["--p" as string]: `${fills[f.field]}%` }} />
                                    {Math.round(fills[f.field])}% filled
                                  </span>
                                )}
                              </span>
                              <span role="cell">{has ? <Status tone={CONF[f.confidence] ?? "partial"}>{f.confidence}</Status> : <Status tone="missing">none</Status>}</span>
                              <FactBar id={`m:${key}.${f.field}`} ctx={at} note={null} />
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {can && !unmappable && (
                    <div className="rv-link-actions">
                      <Fold title="Change this link" note="ask the AI, or edit the query yourself">
                        <form
                          className="stage-form"
                          onSubmit={(e) => {
                            e.preventDefault();
                            const text = (instruction[key] ?? "").trim();
                            if (!text) return;
                            start(async () => {
                              saved(key, await reviseProposalItem(workspaceId, "mapping", step.id, key, text), "Changed by the AI as a new proposal. Only this link changed, and it needs a new confirmation.");
                              setInstruction((s) => ({ ...s, [key]: "" }));
                            });
                          }}
                        >
                          <label>
                            Ask the AI to change this link
                            <input value={instruction[key] ?? ""} maxLength={2000} placeholder="For example: also exclude locations whose name starts with Legacy" onChange={(e) => setInstruction((s) => ({ ...s, [key]: e.target.value }))} />
                          </label>
                          <div className="stage-form-footer">
                            <button type="submit" className="btn btn-secondary" disabled={busy || !(instruction[key] ?? "").trim()}>
                              <Icon name="sparkles" size={17} />
                              <span>Change this link</span>
                            </button>
                          </div>
                        </form>
                        <label className="rv-sql">
                          The query (read-only on their warehouse)
                          <textarea rows={Math.min(18, (sql[key] ?? "").split("\n").length + 1)} spellCheck={false} value={sql[key] ?? ""} onChange={(e) => setSql((s) => ({ ...s, [key]: e.target.value }))} />
                        </label>
                        <div className="stage-form-footer">
                          <button
                            type="button"
                            className="btn btn-secondary"
                            disabled={busy || sql[key] === a.source_sql}
                            onClick={() => start(async () => saved(key, await editProposalItem(workspaceId, "mapping", step.id, key, { ...a, source_sql: sql[key] }), "Query saved and checked again for this link only."))}
                          >
                            <Icon name="refresh" size={17} />
                            <span>Save and check again</span>
                          </button>
                        </div>
                      </Fold>
                      {note[key] && (
                        <p className={cn("rv-alert", !note[key].ok && "rv-alert-fail")} role="status">
                          {note[key].text}
                        </p>
                      )}
                      {ok && !done && (
                        <button
                          type="button"
                          className="btn btn-primary rv-confirm"
                          disabled={busy}
                          onClick={() => start(async () => saved(key, await confirmMappingLink(workspaceId, step.id, key), "Confirmed. This link is kept if the analysis runs again."))}
                        >
                          <Icon name="check" size={17} />
                          <span>Confirm this link</span>
                        </button>
                      )}
                    </div>
                  )}
                </Section>
              </div>
            );
          })}
        </div>
      </section>

      <div data-engineer-chat-host>
        <EngineerChat
          scope="Mapping"
          turns={turns}
          pending=""
          thinking={thinking}
          emptyTitle="What would you like to review?"
          intro="Ask about a link or a field. Hover a shape or a field and press @ to give it to the chat."
          placeholder="Ask about a mapping…"
          starters={["Which mappings need review?", `Explain ${WORDS[reviewable[0]?.a.archetype] ?? "the first link"}`]}
          onAsk={(text) => ask(text)}
          onClear={clear}
          onResend={resend}
          onChange={change}
          context={context}
          onDropContext={(id) => setDropped((d) => [...d, id])}
          mentionables={mentionables}
          mentions={mentions}
          onMentions={setMentioned}
        />
      </div>
      <ChatJump count={mentions.length} />
    </>
  );
}
