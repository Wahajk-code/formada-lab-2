"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { loadRun } from "@/app/console-actions";
import { TrialCardReview, TrialTune } from "@/components/console/onboarding/trial-tools";
import { CardDetail } from "@/components/onboarding/card-detail";
import { Icon } from "@/components/ui/icon";
import type { RunDetail } from "@/lib/console-api";

const STEP_WORDS: Record<string, string> = {
  metrics_run: "Read the warehouse and ran the calculations",
  signals_detect: "Looked for problems",
  prompt_build: "Prepared the card writer's brief",
  llm_generate: "AI wrote the cards",
  cards_ingest: "Checked and saved the cards",
  rollup: "Updated the org web roll-ups",
  daily_plan: "Planned the daily check",
};

const time = (s: string | null) => (s ? new Date(s).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }) : "");

function detailText(d: Record<string, unknown>) {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(d)) {
    if (v == null || typeof v === "object") continue;
    parts.push(`${k.replaceAll("_", " ")} ${typeof v === "number" ? v.toLocaleString("en-CA") : String(v)}`);
  }
  return parts.join(" · ");
}

function Stat({ label, value, icon, foot }: { label: string; value: string; icon: "network" | "activity" | "sparkles"; foot: string }) {
  return (
    <div className="stage-panel stage-stat">
      <span className="stage-stat-icon">
        <Icon name={icon} size={17} />
      </span>
      <small>{label}</small>
      <strong>{value}</strong>
      <span className="stage-stat-foot">{foot}</span>
    </div>
  );
}

/** The trial run (Formada.AI design): stats, the verdict with role coverage, insight previews,
 * and the run log and every problem found underneath. */
export function TrialPanel({
  workspaceId,
  runId,
  running,
  roleCount,
  can,
  currency,
}: {
  workspaceId: string;
  runId: string | null;
  running: boolean;
  roleCount: number;
  can: boolean;
  currency: string;
}) {
  const router = useRouter();
  const [run, setRun] = useState<RunDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = running || run?.run.status === "running";

  useEffect(() => {
    if (!runId) return;
    let stop = false;
    const load = async () => {
      const res = await loadRun(workspaceId, runId);
      if (stop) return;
      if (res.ok && res.data) {
        setRun(res.data);
        if (res.data.run.status !== "running" && running) router.refresh();
      } else if (!res.ok) setError(res.error);
    };
    load();
    const t = live ? setInterval(load, 2500) : null;
    return () => {
      stop = true;
      if (t) clearInterval(t);
    };
  }, [workspaceId, runId, live, running, router]);

  const empty = (title: string, text: string, icon: "chart" | "alert-circle") => (
    <section className="stage-panel">
      <div className="stage-empty">
        <span className="stage-heading-icon">
          <Icon name={icon} size={23} />
        </span>
        <h3>{title}</h3>
        <p>{text}</p>
      </div>
    </section>
  );
  if (!runId) return empty("Trial results will appear here", "Run the trial to see role coverage, checks and a preview of the cards.", "chart");
  if (error) return empty("The run could not be loaded", error, "alert-circle");
  if (!run)
    return empty("Loading the run…", "The results appear here as soon as they are ready.", "chart");

  const kept = run.signals.filter((s) => s.status === "carded" || s.status === "selected");
  const dropped = run.signals.filter((s) => s.status !== "carded" && s.status !== "selected");
  const cost = run.calls.reduce((s, c) => s + (c.cost_usd ?? 0), 0);
  const roles = [...new Set(run.steps.map((s) => s.role).filter((r) => r !== "tenant"))];
  const stepsOk = run.steps.filter((s) => s.status === "ok").length;
  const roleOk = (r: string) => run.steps.filter((s) => s.role === r).every((s) => s.status === "ok");
  const passed = roles.filter(roleOk).length;
  const succeeded = run.run.status === "succeeded";
  const title = live
    ? "The run is working"
    : !succeeded
      ? "Needs attention"
      : run.cards.length
        ? "Completed with insights"
        : "Completed with no actionable signals";
  const description = live
    ? "Progress updates by itself."
    : !succeeded
      ? "Review the role coverage below, then run again before going live."
      : run.cards.length
        ? "Every role ran. Review the cards each role would see before going live."
        : "Every role ran successfully. The customer can still go live.";
  const cardsByRole = (r: string) => run.cards.filter((c) => c.role === r).length;
  return (
    <>
      <div className="stage-stats">
        <Stat label="Roles passed" value={`${passed}/${roles.length || roleCount}`} icon="network" foot="Roles that ran without a failed step" />
        <Stat label="Steps passed" value={`${stepsOk}/${run.steps.length}`} icon="activity" foot="Across every role and the workspace" />
        <Stat label="Insights generated" value={String(run.cards.length)} icon="sparkles" foot={`${run.signals.length} problems found · AI US$${cost.toFixed(4)}`} />
      </div>
      <section className="stage-panel stage-content-panel">
        <div className="stage-panel-heading">
          <span className="stage-heading-icon">
            <Icon name={succeeded ? "check-circle" : "alert-circle"} size={19} />
          </span>
          <div>
            <h3>{title}</h3>
            <p>{description}</p>
          </div>
          <span className={`stage-badge ${live ? "accent" : succeeded ? "positive" : "attention"}`}>
            {live ? "Running" : succeeded ? "Ready to review" : "Action required"}
          </span>
        </div>
        {roles.length > 0 && (
          <details className="stage-disclosure" open={!succeeded && !live}>
            <summary>
              <span>See role coverage</span>
              <Icon name="chevron-down" size={15} />
            </summary>
            <div className="stage-role-coverage">
              {roles.map((r) => (
                <div key={r}>
                  <span>
                    <strong>{r}</strong>
                    <small>{cardsByRole(r) ? `${cardsByRole(r)} card${cardsByRole(r) === 1 ? "" : "s"}` : "No cards this run"}</small>
                  </span>
                  <span className={`stage-badge ${roleOk(r) ? "positive" : "attention"}`}>{roleOk(r) ? "Passed" : "Step failed"}</span>
                </div>
              ))}
            </div>
          </details>
        )}
        {run.cards.length > 0 && (
          <div className="trial-insight-section">
            <h4>Insight previews</h4>
            <div className="stage-trial-cards">
              {run.cards.map((c, i) => (
                <div key={c.id}>
                  <CardDetail card={c} open={i === 0} />
                  <TrialCardReview workspaceId={workspaceId} card={c} can={can} />
                </div>
              ))}
            </div>
          </div>
        )}
        {succeeded && !live && <TrialTune workspaceId={workspaceId} can={can} currency={currency} />}
        {run.rejections.length > 0 && (
          <p className="stage-helper">{run.rejections.length} cards were rejected by the checks and are not shown.</p>
        )}
        <details className="stage-disclosure">
          <summary>
            <span>Run log{live ? " (live)" : ""}</span>
            <Icon name="chevron-down" size={15} />
          </summary>
          <ol className="stage-role-coverage font-mono text-[11px]">
            {run.steps.map((s, i) => (
              <li key={i}>
                <span>
                  <strong>
                    {time(s.started_at)} {s.role === "tenant" ? "Workspace" : s.role} · {STEP_WORDS[s.step] ?? s.step}
                  </strong>
                  <small>{detailText(s.detail)}</small>
                </span>
                <span className={`stage-badge ${s.status === "ok" ? "positive" : s.status === "running" ? "accent" : "attention"}`}>{s.status}</span>
              </li>
            ))}
          </ol>
        </details>
        {run.signals.length > 0 && (
          <details className="stage-disclosure">
            <summary>
              <span>
                Every problem found: {kept.length} kept, {dropped.length} filtered out
              </span>
              <Icon name="chevron-down" size={15} />
            </summary>
            <div className="stage-table-scroll">
              <table className="stage-table">
                <thead>
                  <tr>
                    <th scope="col">Role</th>
                    <th scope="col">Where</th>
                    <th scope="col">Kind</th>
                    <th scope="col">At stake</th>
                    <th scope="col">Outcome</th>
                  </tr>
                </thead>
                <tbody>
                  {[...run.signals].sort((a, b) => b.impact - a.impact).map((s, i) => (
                    <tr key={i}>
                      <td>{s.role}</td>
                      <td>{s.entity}</td>
                      <td>{s.kind}</td>
                      <td className="stage-mono">{Math.round(s.impact).toLocaleString("en-CA")}</td>
                      <td>
                        <span className={`stage-badge ${s.status === "carded" ? "positive" : s.status === "selected" ? "accent" : ""}`}>{s.status}</span>
                        {s.reason && <small> {s.reason}</small>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </section>
    </>
  );
}
