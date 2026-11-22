"use client";

import { Pause, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { runFlowNow, setFlowPaused } from "@/app/console-actions";
import { FlowGraph } from "@/components/console/workflows/flow-graph";
import { Section, Status, type Tone } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { FlowsOverview, FlowView } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/** Workflows: every flow the scheduler runs, drawn from the same data it runs, with a pause switch
 * and Run now. Times are shown in UTC so the server and the browser print the same text. */

const stamp = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const when = (iso: string | null) => (iso ? `${stamp.format(new Date(iso))} UTC` : "–");
const TONE: Record<string, Tone> = { ok: "ready", running: "info", partial: "partial", failed: "fail", skipped: "missing" };
const WORD: Record<string, string> = { ok: "Ok", running: "Running", partial: "Partly", failed: "Failed", skipped: "Skipped" };
const TRIGGER: Record<string, string> = { scheduled: "On schedule", manual: "Run now", feedback: "After feedback" };

function StateChip({ flow, on }: { flow: FlowView; on: boolean }) {
  if (!on) return <Status tone="missing">Scheduler off here</Status>;
  if (flow.paused) return <Status tone="partial">Paused</Status>;
  if (flow.history[0]?.status === "running") return <Status tone="info">Running now</Status>;
  return <Status tone="ready">On schedule</Status>;
}

export function FlowBoard({ data, workspaces, can }: { data: FlowsOverview; workspaces: { id: string; name: string }[]; can: boolean }) {
  const router = useRouter();
  const [key, setKey] = useState(data.flows[0]?.key ?? "");
  const [tenant, setTenant] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const flow = data.flows.find((f) => f.key === key) ?? data.flows[0];
  if (!flow) return null;
  const needsWorkspace = Boolean(flow.run_type) || flow.key === "digest";

  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) =>
    start(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.ok ? ok : (res.error ?? "Failed") });
      router.refresh();
    });

  return (
    <div className="rv">
      {!data.enabled && (
        <p className="rv-alert" role="status">
          <b>{data.lab ? "This is the review lab." : "The scheduler is off on this server."}</b>{" "}
          {data.lab
            ? "It has no live runs and makes no cards, so nothing here runs. The workflows below are the real ones."
            : "Set SCHEDULER_ENABLED=true on one API instance to turn it on."}
        </p>
      )}

      <div className="wf-strip" role="tablist" aria-label="Workflows">
        {data.flows.map((f) => (
          <button key={f.key} type="button" role="tab" aria-selected={f.key === flow.key} className={cn("wf-tab", f.key === flow.key && "is-on")} onClick={() => setKey(f.key)}>
            <b>{f.name}</b>
            <small>{f.schedule ?? "On demand"}</small>
            <StateChip flow={f} on={data.enabled} />
          </button>
        ))}
      </div>

      <Section
        id={`flow-${flow.key}`}
        icon="network"
        title={flow.name}
        count={<StateChip flow={flow} on={data.enabled} />}
        point={flow.purpose}
        tools={
          can ? (
            <div className="wf-actions">
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act(() => setFlowPaused(flow.key, !flow.paused), flow.paused ? "Resumed. It runs on its next slot." : "Paused. Scheduled starts are skipped; Run now still works.")}>
                {flow.paused ? <Play size={15} /> : <Pause size={15} />}
                <span>{flow.paused ? "Resume" : "Pause"}</span>
              </button>
            </div>
          ) : undefined
        }
      >
        <FlowGraph key={flow.key} flow={flow} />

        <div className="rv-block">
          <div className="rv-sub">
            <h6>Run it now</h6>
          </div>
          {can ? (
            <div className="wf-run">
              {needsWorkspace ? (
                <label>
                  <small>Workspace</small>
                  <select value={tenant} onChange={(e) => setTenant(e.target.value)}>
                    <option value="">Choose a workspace</option>
                    {workspaces.map((w) => (
                      <option key={w.id} value={w.id}>
                        {w.name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className="rv-muted">Covers every workspace.</p>
              )}
              <button type="button" className="btn btn-primary" disabled={busy || !data.enabled || (needsWorkspace && !tenant)} onClick={() => act(() => runFlowNow(flow.key, needsWorkspace ? tenant : null), "Started. It shows below in a moment.")}>
                <Icon name="play" size={16} /> <span>Run now</span>
              </button>
              {!data.enabled && <small className="rv-muted">Not available while the scheduler is off.</small>}
            </div>
          ) : (
            <p className="rv-muted">You need permission to start runs.</p>
          )}
          {msg && (
            <p className={cn("rv-alert", !msg.ok && "rv-alert-fail")} role="status">
              {msg.text}
            </p>
          )}
          <p className="rv-muted wf-rules">
            Each call is tried {data.tries} times, {data.wait_s} seconds apart. A workspace runs at most {data.max_runs_per_workspace} at once, and starting the same slot twice does nothing.
            {flow.next_at && !flow.paused && data.enabled && <> Next tick: {when(flow.next_at)}.</>}
          </p>
        </div>

        <div className="rv-block">
          <div className="rv-sub">
            <h6>
              Latest starts <small>since the API last started</small>
            </h6>
          </div>
          {flow.history.length === 0 ? (
            <p className="rv-muted">None yet.</p>
          ) : (
            <ul className="wf-list">
              {flow.history.map((h, i) => (
                <li key={i}>
                  <Status tone={TONE[h.status] ?? "info"}>{WORD[h.status] ?? h.status}</Status>
                  <span>
                    {TRIGGER[h.trigger] ?? h.trigger}
                    {h.workspaces > 0 && ` · ${h.workspaces} ${h.workspaces === 1 ? "workspace" : "workspaces"}`}
                    {h.note && <small className="rv-muted"> · {h.note}</small>}
                  </span>
                  <small className="rv-muted">{when(h.started_at)}</small>
                </li>
              ))}
            </ul>
          )}
        </div>

        {flow.run_type && (
          <div className="rv-block">
            <div className="rv-sub">
              <h6>
                Latest runs <small>kept in the database, with their steps</small>
              </h6>
            </div>
            {flow.runs.length === 0 ? (
              <p className="rv-muted">No runs yet.</p>
            ) : (
              <ul className="wf-list">
                {flow.runs.map((r) => (
                  <li key={r.run_id}>
                    <Status tone={TONE[r.status === "succeeded" ? "ok" : r.status] ?? "info"}>{WORD[r.status] ?? r.status}</Status>
                    <span>
                      <Link href={`/console/workspaces/${r.workspace_id}/runs/${r.run_id}`}>{r.workspace}</Link>
                      {r.error && <small className="rv-muted"> · {r.error.slice(0, 90)}</small>}
                    </span>
                    <small className="rv-muted">{when(r.started_at)}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Section>
    </div>
  );
}
