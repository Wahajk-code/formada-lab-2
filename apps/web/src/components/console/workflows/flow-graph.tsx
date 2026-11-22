"use client";

import { Fragment, useMemo, useState } from "react";

import { humanName, Status, type Tone } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { FlowStep, FlowView, NodeInfo, NodeState, RunState } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/**
 * One workflow as a flow chart. Steps run top to bottom; the arrow between two steps is what
 * happens next when the step goes well. A dashed line to the right of a step leads to what happens
 * when it does not (it has nothing to do, or it fails after its tries). The steps that run once for
 * every role sit in one box. Give it a run and every step shows where that run is: done, running,
 * failed, or not reached. It draws the same data the scheduler runs (`domain/flows.py`).
 */

type Numbered = { step: FlowStep; n: number };
type Segment = { kind: "steps" | "loop"; items: Numbered[] };

function segments(steps: FlowStep[]): Segment[] {
  const out: Segment[] = [];
  steps.forEach((step, i) => {
    const kind = step.scope === "role" ? "loop" : "steps";
    const last = out[out.length - 1];
    if (last?.kind === kind) last.items.push({ step, n: i + 1 });
    else out.push({ kind, items: [{ step, n: i + 1 }] });
  });
  return out;
}

const STATE: Record<NodeState, { tone: Tone; word: string }> = {
  waiting: { tone: "missing", word: "Waiting" },
  none: { tone: "missing", word: "Not reached" },
  running: { tone: "info", word: "Running" },
  progress: { tone: "info", word: "In progress" },
  ok: { tone: "ready", word: "Done" },
  skipped: { tone: "missing", word: "Skipped" },
  partial: { tone: "partial", word: "Partly" },
  failed: { tone: "fail", word: "Failed" },
};
const ROLE_STATE: Record<string, { tone: Tone; word: string }> = {
  ok: STATE.ok,
  running: STATE.running,
  skipped: { tone: "missing", word: "Nothing to do" },
  failed: STATE.failed,
};

/** The other ways out of a step, as one short line each (the side panel has the full words). */
const SKIP_LINE: Record<string, string> = {
  create_run: "Already running: workspace skipped",
  daily_plan: "Nobody today: the run closes",
  signals_detect: "Nothing to flag: role ends quietly",
  prompt_build: "Nothing to write: role ends quietly",
  llm_generate: "No prompt: role ends quietly",
  cards_ingest: "Nothing to save: role ends quietly",
};
const FAIL_LINE = { fail_run: "Fails 3 times: run marked failed", fail_step: "Fails 3 times: role marked failed", log: "Fails 3 times: logged, flow carries on" } as const;

function exits(step: FlowStep): { tone: "skip" | "fail" | "warn" | "note"; text: string }[] {
  const out: { tone: "skip" | "fail" | "warn" | "note"; text: string }[] = [];
  if (step.skips) out.push({ tone: "skip", text: SKIP_LINE[step.key] ?? "Nothing to do: ends quietly" });
  if (step.failure) out.push({ tone: step.on_error === "fail_run" ? "fail" : step.on_error === "fail_step" ? "warn" : "note", text: FAIL_LINE[step.on_error] });
  return out;
}

function progress(info: NodeInfo | undefined, step: FlowStep) {
  if (!info) return null;
  if (step.scope === "role" && info.total > 0) return `${info.done} of ${info.total} roles${info.failed ? ` · ${info.failed} failed` : ""}`;
  return null;
}

function Node({ step, n, info, data, on, onPick }: { step: FlowStep; n: number; info?: NodeInfo; data: boolean; on: boolean; onPick: () => void }) {
  const st = info ? STATE[info.state] : null;
  const prog = progress(info, step);
  return (
    <button type="button" className={cn("fx-node", on && "is-on")} data-state={info?.state} onClick={onPick} aria-pressed={on}>
      <span className="fx-n">{n}</span>
      <span className="fx-title">
        <b>{step.label}</b>
        {step.ai && (
          <span className="fx-ai">
            <Icon name="sparkles" size={11} /> AI
          </span>
        )}
      </span>
      <span className="fx-does">{step.does}</span>
      {st && (
        <span className="fx-live">
          {info!.state === "running" ? <i className="fx-dot" aria-hidden /> : null}
          <Status tone={st.tone}>{st.word}</Status>
          {prog && <small>{prog}</small>}
        </span>
      )}
      {data && (
        <span className="fx-data">
          {step.reads.length > 0 && (
            <span>
              <small>reads</small>
              {step.reads.map((t) => (
                <code key={t}>{humanName(t)}</code>
              ))}
            </span>
          )}
          {step.writes.length > 0 && (
            <span>
              <small>writes</small>
              {step.writes.map((t) => (
                <code key={t} className="is-write">
                  {humanName(t)}
                </code>
              ))}
            </span>
          )}
        </span>
      )}
    </button>
  );
}

function Exits({ step }: { step: FlowStep }) {
  const list = exits(step);
  if (!list.length) return <div className="fx-exits" />;
  return (
    <div className="fx-exits">
      {list.map((e, i) => (
        <div key={i} className={cn("fx-exit", `fx-exit-${e.tone}`)}>
          <span className="fx-exit-line" aria-hidden />
          <span className="fx-exit-box">{e.text}</span>
        </div>
      ))}
    </div>
  );
}

export function FlowDiagram({ flow, live }: { flow: FlowView; live: RunState | null }) {
  const rows = useMemo(() => segments(flow.steps), [flow.steps]);
  const [key, setKey] = useState<string | null>(null);
  const [data, setData] = useState(false);
  const chosen = flow.steps.find((s) => s.key === key) ?? null;
  const rolesDone = live ? Math.max(0, ...flow.steps.filter((s) => s.scope === "role").map((s) => live.nodes[s.key]?.done ?? 0)) : 0;
  const line = ({ step, n }: Numbered) => (
    <div key={step.key} className="fx-line">
      <div className="fx-node-col">
        <Node step={step} n={n} info={live?.nodes[step.key]} data={data} on={key === step.key} onPick={() => setKey(key === step.key ? null : step.key)} />
      </div>
      <Exits step={step} />
    </div>
  );
  const link = (k: string) => (
    <div key={k} className="fx-link" aria-hidden>
      <span />
    </div>
  );

  return (
    <div className="fx">
      <div className="fx-main">
        <div className="fx-toolbar">
          <label className="fx-toggle">
            <input type="checkbox" checked={data} onChange={(e) => setData(e.target.checked)} />
            <span>Show the tables each step reads and writes</span>
          </label>
        </div>

        <div className="fx-start">
          <Icon name="clock" size={15} />
          <span>
            <b>{flow.schedule ?? "On demand"}</b>
            {flow.schedule_note && <small> · {flow.schedule_note}</small>}
            {flow.also && <small> · also {flow.also.toLowerCase()}</small>}
          </span>
        </div>

        <div className="fx-chart" aria-label={`${flow.name}: steps in order`}>
          {rows.map((row, i) => (
            <Fragment key={i}>
              {link(`l${i}`)}
              {row.kind === "steps" ? (
                row.items.map((it, j) => (
                  <Fragment key={it.step.key}>
                    {j > 0 && link(`s${i}-${j}`)}
                    {line(it)}
                  </Fragment>
                ))
              ) : (
                <div className="fx-loop">
                  <p className="fx-loop-title">
                    <Icon name="refresh" size={13} /> For each role, one at a time
                    {live && live.roles_expected > 0 && <small>{rolesDone} of {live.roles_expected} roles through</small>}
                  </p>
                  {row.items.map((it, j) => (
                    <Fragment key={it.step.key}>
                      {j > 0 && link(`r${i}-${j}`)}
                      {line(it)}
                    </Fragment>
                  ))}
                </div>
              )}
            </Fragment>
          ))}
        </div>
      </div>

      <aside className="fx-inspect" aria-label="Step detail">
        {!chosen ? (
          <div className="fx-hint">
            <b>Click a step</b>
            <p>to see what it does, what it reads and writes, and what happens when it fails.</p>
            <p className="fx-rules">
              Every call is tried 3 times, 5 seconds apart. A step that says &ldquo;nothing to do&rdquo; is not an error. A step that fails after its tries marks the role (or the run) failed, and the flow carries on.
            </p>
          </div>
        ) : (
          <div className="fx-detail">
            <header>
              <b>{chosen.label}</b>
              {live?.nodes[chosen.key] && <Status tone={STATE[live.nodes[chosen.key].state].tone}>{STATE[live.nodes[chosen.key].state].word}</Status>}
              {chosen.ai && <Status tone="decide">Calls the AI</Status>}
            </header>
            <p>{chosen.does}</p>
            <dl>
              <div>
                <dt>Time allowed</dt>
                <dd>{chosen.timeout_s >= 60 ? `${Math.round(chosen.timeout_s / 60)} min` : `${chosen.timeout_s} s`} per try</dd>
              </div>
              {chosen.skips && (
                <div>
                  <dt>Nothing to do</dt>
                  <dd>{chosen.skips}</dd>
                </div>
              )}
              {chosen.failure && (
                <div>
                  <dt>If it fails</dt>
                  <dd>{chosen.failure}</dd>
                </div>
              )}
              <div>
                <dt>Reads</dt>
                <dd className="fx-chips">{chosen.reads.length ? chosen.reads.map((t) => <code key={t}>{humanName(t)}</code>) : <em>nothing in the database</em>}</dd>
              </div>
              <div>
                <dt>Writes</dt>
                <dd className="fx-chips">{chosen.writes.length ? chosen.writes.map((t) => <code key={t} className="is-write">{humanName(t)}</code>) : <em>nothing</em>}</dd>
              </div>
            </dl>
            {live && chosen.scope === "role" && (
              <div className="fx-roles">
                <b>Each role</b>
                {live.roles.length === 0 ? (
                  <p className="fx-muted">No role has reached this step yet.</p>
                ) : (
                  <ul>
                    {live.roles.map((r) => {
                      const s = r.steps[chosen.key];
                      // A role that ended quietly at an earlier step is not "not reached": it was not needed here.
                      const order = flow.steps.filter((x) => x.scope === "role").map((x) => x.key);
                      const endedEarlier = order.slice(0, order.indexOf(chosen.key)).some((k) => r.steps[k] === "skipped");
                      const v = s ? ROLE_STATE[s] : { tone: "missing" as Tone, word: endedEarlier ? "Ended earlier" : "Not reached" };
                      return (
                        <li key={r.id}>
                          <span>{r.title}</span>
                          <Status tone={v.tone}>{v.word}</Status>
                        </li>
                      );
                    })}
                  </ul>
                )}
                {live.roles_expected > live.roles.length && (
                  <p className="fx-muted">
                    {live.roles_expected - live.roles.length} {live.roles_expected - live.roles.length === 1 ? "role has" : "roles have"} not started yet.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
