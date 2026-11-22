"use client";

import { Fragment, useMemo, useState } from "react";

import { humanName, Status } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { FlowStep, FlowView } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/**
 * One workflow as a picture: its steps in the order they run, the role steps boxed as "for each
 * role", and the tables each step reads and writes. Pick a table to see which steps touch it; pick a
 * step for the detail and what happens when it fails. It draws the same data the scheduler runs
 * (`domain/flows.py`), so it cannot drift from what happens.
 */

type Numbered = { step: FlowStep; n: number };
type Segment = { kind: "steps" | "loop"; items: Numbered[] };

/** The steps in order, cut into rows: the workspace steps before the role loop, the loop itself (the
 * consecutive role steps), and the workspace steps after it. */
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

const FAIL_WORDS = { fail_run: "Fails the run", fail_step: "Fails this role", log: "Logged only" } as const;
const touches = (s: FlowStep, table: string) => s.reads.includes(table) || s.writes.includes(table);
const seconds = (s: number) => (s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`);

function StepCard({ step, n, on, dim, picked, onPick }: { step: FlowStep; n: number; on: boolean; dim: boolean; picked: boolean; onPick: () => void }) {
  return (
    <button type="button" className={cn("wf-step", on && "is-on", dim && "is-dim", picked && "is-hit")} onClick={onPick} aria-pressed={on}>
      <span className="wf-step-n">{n}</span>
      <b>{step.label}</b>
      <span className="wf-step-does">{step.does}</span>
      <span className="wf-step-tags">
        {step.ai && (
          <span className="wf-tag wf-tag-ai">
            <Icon name="sparkles" size={11} /> AI
          </span>
        )}
        {step.writes.length > 0 && <span className="wf-tag">writes {step.writes.length}</span>}
        {step.reads.length > 0 && <span className="wf-tag wf-tag-read">reads {step.reads.length}</span>}
      </span>
    </button>
  );
}

export function FlowGraph({ flow }: { flow: FlowView }) {
  const rows = useMemo(() => segments(flow.steps), [flow.steps]);
  const [stepKey, setStepKey] = useState<string | null>(null);
  const [table, setTable] = useState<string | null>(null);
  const chosen = flow.steps.find((s) => s.key === stepKey) ?? null;
  const dim = (s: FlowStep) => Boolean(table) && !touches(s, table!);
  const card = (step: FlowStep, n: number) => (
    <StepCard key={step.key} step={step} n={n} on={stepKey === step.key} dim={dim(step)} picked={Boolean(table) && touches(step, table!)} onPick={() => setStepKey(stepKey === step.key ? null : step.key)} />
  );
  return (
    <div className="wf-graph">
      <div className="wf-start">
        <Icon name="clock" size={15} />
        <span>
          <b>{flow.schedule ?? "On demand"}</b>
          {flow.schedule_note && <small> · {flow.schedule_note}</small>}
          {flow.also && <small> · also: {flow.also.toLowerCase()}</small>}
        </span>
      </div>

      <div className="wf-rows" aria-label={`${flow.name}: steps in order`}>
        {rows.map((row, i) => (
          <Fragment key={i}>
            {i > 0 && (
              <div className="wf-down" aria-hidden>
                <Icon name="chevron-down" size={20} />
              </div>
            )}
            {row.kind === "steps" ? (
              <ol className="wf-flow">
                {row.items.map(({ step, n }) => (
                  <li key={step.key} className="wf-item">
                    {card(step, n)}
                  </li>
                ))}
              </ol>
            ) : (
              <div className="wf-loop-box">
                <p className="wf-loop-title">
                  <Icon name="refresh" size={13} /> For each role, one at a time
                </p>
                <ol className="wf-loop-steps">
                  {row.items.map(({ step, n }) => (
                    <li key={step.key} className="wf-item">
                      {card(step, n)}
                    </li>
                  ))}
                </ol>
                <p className="wf-loop-note">A step that says &ldquo;skipped&rdquo; ends that role quietly. A step that still fails after its tries marks the role failed; the other roles carry on.</p>
              </div>
            )}
          </Fragment>
        ))}
      </div>

      {chosen && (
        <aside className="wf-detail" aria-label={`${chosen.label} detail`}>
          <header>
            <b>{chosen.label}</b>
            <Status tone={chosen.on_error === "fail_run" ? "fail" : chosen.on_error === "fail_step" ? "partial" : "info"}>{FAIL_WORDS[chosen.on_error]}</Status>
            {chosen.ai && <Status tone="decide">Calls the AI</Status>}
            <small>
              up to {seconds(chosen.timeout_s)} per try <code>{chosen.key}</code>
            </small>
          </header>
          <p>{chosen.does}</p>
          {chosen.failure && (
            <p className="wf-fail">
              <b>If it fails:</b> {chosen.failure}
            </p>
          )}
          <div className="wf-data">
            <div>
              <small>Reads</small>
              <span className="wf-chips">{chosen.reads.length ? chosen.reads.map((t) => <code key={t}>{humanName(t)}</code>) : <em>nothing in the database</em>}</span>
            </div>
            <div>
              <small>Writes</small>
              <span className="wf-chips">{chosen.writes.length ? chosen.writes.map((t) => <code key={t} className="is-write">{humanName(t)}</code>) : <em>nothing</em>}</span>
            </div>
          </div>
        </aside>
      )}

      <div className="wf-tables">
        <div className="wf-tables-head">
          <b>The data it touches</b>
          <small>Pick a table to see which steps read or write it.</small>
          {table && (
            <button type="button" className="stage-inline-link" onClick={() => setTable(null)}>
              Clear
            </button>
          )}
        </div>
        <div className="wf-data">
          <div>
            <small>Reads</small>
            <span className="wf-chips">
              {flow.reads.map((t) => (
                <button key={t} type="button" className={cn("wf-table", table === t && "is-on")} aria-pressed={table === t} onClick={() => setTable(table === t ? null : t)}>
                  {humanName(t)}
                </button>
              ))}
            </span>
          </div>
          <div>
            <small>Writes</small>
            <span className="wf-chips">
              {flow.writes.map((t) => (
                <button key={t} type="button" className={cn("wf-table is-write", table === t && "is-on")} aria-pressed={table === t} onClick={() => setTable(table === t ? null : t)}>
                  {humanName(t)}
                </button>
              ))}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
