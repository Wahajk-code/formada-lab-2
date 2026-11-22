"use client";

import { Pause, Play } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { runFlowNow, setFlowPaused } from "@/app/console-actions";
import { FlowDiagram } from "@/components/console/workflows/flow-graph";
import { Status, type Tone } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { FlowBoardData, FlowsOverview, FlowView, RunState } from "@/lib/console-api";
import { cn } from "@/lib/utils";

/**
 * Workflows. Pick a flow, see it as a flow chart, and watch any workspace's run on it. Everything
 * you can do is on the page: Pause, Run now, and Watch. While anything is running the page
 * refreshes itself. Times are in UTC so the server and the browser print the same text.
 */

const stamp = new Intl.DateTimeFormat("en-CA", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
const when = (iso: string | null) => (iso ? `${stamp.format(new Date(iso))} UTC` : "–");
const RUN: Record<string, { tone: Tone; word: string }> = {
  running: { tone: "info", word: "Running" },
  succeeded: { tone: "ready", word: "Succeeded" },
  ok: { tone: "ready", word: "Ok" },
  partial: { tone: "partial", word: "Partly" },
  failed: { tone: "fail", word: "Failed" },
  skipped: { tone: "missing", word: "Skipped" },
};
const TRIGGER: Record<string, string> = { scheduled: "On schedule", manual: "Run now", feedback: "After feedback" };

function flowState(f: FlowView, on: boolean): { tone: Tone; word: string } {
  if (!on) return { tone: "missing", word: "Off here" };
  if (f.paused) return { tone: "partial", word: "Paused" };
  if (f.history[0]?.status === "running") return { tone: "info", word: "Running" };
  return { tone: "ready", word: "On schedule" };
}

export function FlowBoard({ data, flowKey, board, live, selectedWs, workspaces, can }: { data: FlowsOverview; flowKey: string; board: FlowBoardData | null; live: RunState | null; selectedWs: string | null; workspaces: { id: string; name: string }[]; can: boolean }) {
  const router = useRouter();
  const [tenant, setTenant] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, start] = useTransition();
  const flow = data.flows.find((f) => f.key === flowKey) ?? data.flows[0];
  const needsWorkspace = Boolean(flow?.run_type) || flow?.key === "digest";
  const going = Boolean(board?.workspaces.some((w) => w.run?.status === "running") || live?.run.status === "running" || flow?.history[0]?.status === "running");

  // Watch it happen: refresh while anything is running.
  useEffect(() => {
    if (!going) return;
    const t = setInterval(() => router.refresh(), 4000);
    return () => clearInterval(t);
  }, [going, router]);

  if (!flow) return null;
  const href = (f: string, ws?: string | null) => `/console/workflows?flow=${f}${ws ? `&ws=${ws}` : ""}`;
  const act = (fn: () => Promise<{ ok: boolean; error?: string }>, ok: string) =>
    start(async () => {
      const res = await fn();
      setMsg({ ok: res.ok, text: res.ok ? ok : (res.error ?? "Failed") });
      router.refresh();
    });
  const state = flowState(flow, data.enabled);
  const runningNow = (f: FlowView) => f.history[0]?.status === "running";

  return (
    <div className="fx-page">
      {!data.enabled && (
        <p className="rv-alert" role="status">
          <b>{data.lab ? "This is the review lab." : "The scheduler is off on this server."}</b>{" "}
          {data.lab ? "It has no live runs and makes no cards, so nothing runs here. The flows below are the real ones." : "Set SCHEDULER_ENABLED=true on one API instance to turn it on."}
        </p>
      )}

      <nav className="fx-picker" aria-label="Workflows">
        {data.flows.map((f) => {
          const s = flowState(f, data.enabled);
          return (
            <Link key={f.key} href={href(f.key)} className={cn("fx-pick", f.key === flow.key && "is-on")} aria-current={f.key === flow.key ? "page" : undefined}>
              <b>{f.name}</b>
              <span>
                {runningNow(f) && <i className="fx-dot" aria-hidden />}
                <small>{s.word}</small>
              </span>
            </Link>
          );
        })}
      </nav>

      <section className="fx-panel">
        <header className="fx-head">
          <div>
            <h2>
              {flow.name} <Status tone={state.tone}>{state.word}</Status>
            </h2>
            <p>{flow.purpose}</p>
          </div>
          {can && (
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => act(() => setFlowPaused(flow.key, !flow.paused), flow.paused ? "Resumed. It runs on its next slot." : "Paused. Scheduled starts are skipped; Run now still works.")}>
              {flow.paused ? <Play size={15} /> : <Pause size={15} />}
              <span>{flow.paused ? "Resume" : "Pause"}</span>
            </button>
          )}
        </header>

        {can && (
          <div className="fx-run">
            <span className="fx-run-label">Run it now</span>
            {needsWorkspace && (
              <select aria-label="Workspace" value={tenant} onChange={(e) => setTenant(e.target.value)}>
                <option value="">Choose a workspace</option>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            )}
            <button type="button" className="btn btn-primary" disabled={busy || !data.enabled || (needsWorkspace && !tenant)} onClick={() => act(() => runFlowNow(flow.key, needsWorkspace ? tenant : null), "Started. Watch it below.")}>
              <Icon name="play" size={15} /> <span>{needsWorkspace ? "Run" : "Run for every workspace"}</span>
            </button>
            {!data.enabled && <small className="rv-muted">Not available while the scheduler is off.</small>}
            {msg && (
              <span className={cn("fx-msg", !msg.ok && "is-bad")} role="status">
                {msg.text}
              </span>
            )}
          </div>
        )}

        {flow.run_type && (
          <div className="fx-watch">
            <label>
              <span>Show a workspace&rsquo;s run on the chart</span>
              <select value={selectedWs ?? ""} onChange={(e) => router.push(href(flow.key, e.target.value || null))}>
                <option value="">None: show how the flow works</option>
                {board?.workspaces.map((w) => (
                  <option key={w.workspace.id} value={w.workspace.id} disabled={!w.run}>
                    {w.workspace.name}
                    {w.run ? ` · ${RUN[w.run.status]?.word ?? w.run.status}` : " · no run yet"}
                  </option>
                ))}
              </select>
            </label>
            {live && (
              <p className="fx-watching">
                <Icon name="eye" size={15} />
                <span>
                  <b>{live.workspace.name}</b>: {live.run.by_hand ? "started by hand" : "scheduled"}, {when(live.run.started_at)}
                  {live.run.ended_at ? `, ended ${when(live.run.ended_at)}` : ""}
                </span>
                <Status tone={RUN[live.run.status]?.tone ?? "info"}>{RUN[live.run.status]?.word ?? live.run.status}</Status>
                {going && <small className="rv-muted">updating every few seconds</small>}
              </p>
            )}
            {live?.run.error && <p className="rv-alert rv-alert-fail">{live.run.error}</p>}
          </div>
        )}

        <FlowDiagram key={`${flow.key}:${live?.run.id ?? "static"}`} flow={flow} live={live} />

        {flow.run_type ? (
          <div className="fx-monitor">
            <h3>Workspaces</h3>
            <p className="rv-muted">The latest {flow.name.toLowerCase()} of every workspace. Watch one to see it on the chart.</p>
            {!board || board.workspaces.length === 0 ? (
              <p className="rv-muted">No workspaces yet.</p>
            ) : (
              <ul className="fx-ws">
                {board.workspaces.map((w) => {
                  const st = w.run ? (RUN[w.run.status] ?? { tone: "info" as Tone, word: w.run.status }) : null;
                  const p = w.progress;
                  return (
                    <li key={w.workspace.id} className={cn(selectedWs === w.workspace.id && "is-on")}>
                      <b>{w.workspace.name}</b>
                      {w.run && st ? (
                        <>
                          <span className="fx-ws-status">
                            {w.run.status === "running" && <i className="fx-dot" aria-hidden />}
                            <Status tone={st.tone}>{st.word}</Status>
                          </span>
                          <span className="fx-ws-progress">
                            {w.run.status === "running" ? (
                              <>
                                {p?.current ?? "Starting"}
                                {p && p.roles_total > 0 && ` · ${p.roles_done} of ${p.roles_total} roles`}
                              </>
                            ) : (
                              <>
                                {p?.steps_done} of {p?.steps_total} steps{p && p.problems > 0 ? ` · ${p.problems} with problems` : ""}
                              </>
                            )}
                            <small className="rv-muted"> · {when(w.run.started_at)}</small>
                          </span>
                          <Link className="stage-inline-link" href={href(flow.key, w.workspace.id)} scroll={false}>
                            {selectedWs === w.workspace.id ? "Watching" : "Watch"}
                          </Link>
                        </>
                      ) : (
                        <>
                          <span className="fx-ws-status">
                            <Status tone="missing">No run yet</Status>
                          </span>
                          <span className="fx-ws-progress rv-muted">It shows here when this workspace first runs.</span>
                          <span />
                        </>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        ) : (
          <div className="fx-monitor">
            <h3>Latest starts</h3>
            <p className="rv-muted">Kept since the API last started. This flow is not tied to one workspace&rsquo;s run.</p>
            {flow.history.length === 0 ? (
              <p className="rv-muted">None yet.</p>
            ) : (
              <ul className="fx-ws">
                {flow.history.map((h, i) => (
                  <li key={i}>
                    <b>{TRIGGER[h.trigger] ?? h.trigger}</b>
                    <span className="fx-ws-status">
                      <Status tone={RUN[h.status]?.tone ?? "info"}>{RUN[h.status]?.word ?? h.status}</Status>
                    </span>
                    <span className="fx-ws-progress">
                      {h.workspaces > 0 ? `${h.workspaces} ${h.workspaces === 1 ? "workspace" : "workspaces"}` : "No workspace needed it"}
                      {h.note && <small className="rv-muted"> · {h.note}</small>}
                      <small className="rv-muted"> · {when(h.started_at)}</small>
                    </span>
                    <span />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <p className="rv-muted fx-foot">
          A workspace runs at most {data.max_runs_per_workspace} at once, and starting the same slot twice does nothing.
          {flow.next_at && !flow.paused && data.enabled && <> Next tick: {when(flow.next_at)}.</>}
        </p>
      </section>
    </div>
  );
}
