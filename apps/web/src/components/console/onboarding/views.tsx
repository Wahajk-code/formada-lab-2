"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */

import {
  Check,
  CircleAlert,
  LoaderCircle,
  RotateCcw,
  TriangleAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import {
  connectMockWarehouse,
  recheckMapping,
  saveConnection,
  selectSnapshot,
} from "@/app/console-actions";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { ConnectionGraphic } from "@/components/onboarding/setup";
import type { OnboardingState, OnboardingStep } from "@/lib/console-api";
import { cn } from "@/lib/utils";

// Technical detail views for the console's onboarding steps, shown under "Technical details".

/** Numbers with thousands separators; anything else as text. */
const num = (v: unknown) => (typeof v === "number" ? v.toLocaleString("en-CA", { maximumFractionDigits: 4 }) : String(v ?? "–"));

export function Badge({
  tone,
  children,
}: {
  tone: "ok" | "warn" | "bad" | "muted";
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium",
        tone === "ok" && "bg-surface-strong",
        tone === "warn" && "bg-brand/10 text-brand",
        tone === "bad" && "bg-brand text-brand-foreground",
        tone === "muted" && "bg-surface text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function Checks({
  checks,
}: {
  checks: { ok?: boolean; errors?: string[]; warnings?: string[] } | undefined;
}) {
  if (!checks) return null;
  const errors = checks.errors ?? [];
  const warnings = checks.warnings ?? [];
  if (!errors.length && !warnings.length)
    return (
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="size-3.5" /> All code checks passed.
      </p>
    );
  return (
    <ul className="space-y-1 text-xs">
      {errors.map((e) => (
        <li
          key={e}
          className="flex gap-1.5 rounded-md bg-brand px-2 py-1 text-brand-foreground"
        >
          <CircleAlert className="mt-0.5 size-3.5 shrink-0" /> {e}
        </li>
      ))}
      {warnings.map((w) => (
        <li
          key={w}
          className="flex gap-1.5 rounded-md bg-brand/10 px-2 py-1 text-brand"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" /> {w}
        </li>
      ))}
    </ul>
  );
}

export function Meta({ step }: { step: OnboardingStep }) {
  const secs = (step.latency_ms / 1000).toFixed(0);
  return (
    <p className="text-[11px] text-muted-foreground">
      {step.agent} · {step.model} ·{" "}
      {(step.tokens.input + step.tokens.output).toLocaleString("en-CA")} tokens
      {step.cost_usd !== null && ` · US$${step.cost_usd.toFixed(3)}`} · {secs}s
      · sent {Math.round(step.input_summary.bytes / 1024)} KB of shape
      {step.approved_by && ` · approved by ${step.approved_by}`}
    </p>
  );
}

export function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-2">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h4>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Step bodies
// ---------------------------------------------------------------------------------------------

export function DiscoveryView({ out }: { out: any }) {
  return (
    <div className="space-y-4 text-sm">
      <p className="leading-relaxed">{out.summary}</p>
      <p className="text-muted-foreground">
        <span className="font-medium text-foreground">Cadence. </span>
        {out.cadence}
      </p>
      <Section title="Coverage against our standard model">
        <div className="flex flex-wrap gap-1.5">
          {out.coverage.map((c: any) => (
            <span key={c.family} title={c.evidence}>
              <Badge
                tone={
                  c.status === "present"
                    ? "ok"
                    : c.status === "partial"
                      ? "warn"
                      : "bad"
                }
              >
                {c.family}: {c.status}
              </Badge>
            </span>
          ))}
        </div>
      </Section>
      <Section title="Tables">
        <div className="overflow-x-auto rounded-xl bg-surface">
          <table className="w-full text-xs">
            <thead className="text-left text-muted-foreground">
              <tr>
                <th className="p-2">Table</th>
                <th className="p-2">Kind</th>
                <th className="p-2">One row is</th>
                <th className="p-2">Joins</th>
              </tr>
            </thead>
            <tbody>
              {out.tables.map((t: any) => (
                <tr
                  key={t.table}
                  className="border-t border-border/50 align-top"
                >
                  <td className="p-2 font-mono">{t.table}</td>
                  <td className="p-2">{t.kind}</td>
                  <td className="p-2">
                    {t.grain}
                    <div className="text-muted-foreground">{t.purpose}</div>
                  </td>
                  <td className="p-2 font-mono text-[11px]">
                    {t.joins.map((j: any) => (
                      <div key={j.column + j.references_table}>
                        {j.column} → {j.references_table}.{j.references_column}{" "}
                        ({j.confidence})
                      </div>
                    ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Quality issues">
        <ul className="space-y-2">
          {out.quality_issues.map((q: any) => (
            <li key={q.title} className="rounded-xl bg-surface p-3">
              <div className="flex items-center gap-2">
                <Badge
                  tone={
                    q.severity === "high"
                      ? "bad"
                      : q.severity === "medium"
                        ? "warn"
                        : "muted"
                  }
                >
                  {q.severity}
                </Badge>
                <span className="font-medium">{q.title}</span>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">{q.evidence}</p>
              <p className="mt-1 text-xs">
                <span className="font-medium">Impact: </span>
                {q.impact}
              </p>
              <p className="mt-0.5 text-xs">
                <span className="font-medium">Handling: </span>
                {q.suggested_handling}
              </p>
            </li>
          ))}
        </ul>
      </Section>
      <Section title="Questions">
        <ol className="list-decimal space-y-1 pl-5 text-xs">
          {out.questions.map((q: any) => (
            <li key={q.question}>
              <span className="font-medium">[{q.to}]</span> {q.question}{" "}
              <span className="text-muted-foreground">: {q.why}</span>
            </li>
          ))}
        </ol>
      </Section>
    </div>
  );
}

export function MappingView({
  step,
  workspaceId,
  can,
}: {
  step: OnboardingStep;
  workspaceId: string;
  can: boolean;
}) {
  const router = useRouter();
  const out = step.output as any;
  const checks = (step.checks?.archetypes ?? {}) as Record<string, any>;
  const [sql, setSql] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      out.archetypes.map((a: any) => [a.archetype, a.source_sql]),
    ),
  );
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const edited = out.archetypes.filter(
    (a: any) => sql[a.archetype] !== a.source_sql,
  );
  return (
    <div className="space-y-4">
      {out.archetypes.map((a: any) => {
        const c = checks[a.archetype] ?? {};
        return (
          <div
            key={a.archetype}
            className="space-y-3 rounded-xl bg-surface p-4"
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-sm font-semibold">
                {a.archetype}
              </span>
              <Badge
                tone={
                  a.status === "mapped"
                    ? "ok"
                    : a.status === "partial"
                      ? "warn"
                      : "muted"
                }
              >
                {a.status}
              </Badge>
              {a.status !== "unmappable" && (
                <Badge tone={c.ok ? "ok" : "bad"}>
                  {c.ok ? "checks pass" : "checks fail"}
                </Badge>
              )}
              {c.rows !== undefined && (
                <span className="text-xs text-muted-foreground">
                  {c.rows?.toLocaleString("en-CA")} rows · {c.dates ?? "–"}{" "}
                  dates · {c.first_date} → {c.last_date}
                </span>
              )}
            </div>
            {a.status !== "unmappable" && (
              <textarea
                value={sql[a.archetype]}
                onChange={(e) =>
                  setSql({ ...sql, [a.archetype]: e.target.value })
                }
                spellCheck={false}
                rows={Math.min(
                  18,
                  (sql[a.archetype] ?? "").split("\n").length + 1,
                )}
                className="w-full rounded-lg bg-card p-3 font-mono text-[11px] leading-relaxed shadow-inner outline-none"
              />
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead className="text-left text-muted-foreground">
                  <tr>
                    <th className="p-1.5">Field</th>
                    <th className="p-1.5">From</th>
                    <th className="p-1.5">Confidence</th>
                    <th className="p-1.5">Fill</th>
                    <th className="p-1.5">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {a.fields.map((f: any) => {
                    const fill = (c.fills ?? []).find(
                      (x: any) => x.field === f.field,
                    );
                    return (
                      <tr
                        key={f.field}
                        className="border-t border-border/40 align-top"
                      >
                        <td className="p-1.5 font-mono">{f.field}</td>
                        <td className="p-1.5 font-mono text-[11px]">
                          {f.source_columns.join(", ") || "NULL"}
                        </td>
                        <td className="p-1.5">
                          <Badge
                            tone={
                              f.confidence === "high"
                                ? "ok"
                                : f.confidence === "medium"
                                  ? "warn"
                                  : "bad"
                            }
                          >
                            {f.confidence}
                          </Badge>
                        </td>
                        <td className="p-1.5 tabular-nums">
                          {fill ? `${fill.fill_pct}%` : "–"}
                        </td>
                        <td className="p-1.5">
                          {f.expression}
                          <div className="text-muted-foreground">
                            {f.reason}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {c.value_mix &&
              Object.entries(c.value_mix).map(([f, vals]: [string, any]) => (
                <p key={f} className="text-xs">
                  <span className="font-mono">{f}</span>:{" "}
                  {vals
                    .map(
                      (v: any) =>
                        `${v.value ?? "NULL"} (${v.rows.toLocaleString("en-CA")})`,
                    )
                    .join(" · ")}
                </p>
              ))}
            {a.filters.length > 0 && (
              <p className="text-xs">
                <span className="font-medium">Filters: </span>
                {a.filters.join("; ")}
              </p>
            )}
            {a.questions.length > 0 && (
              <ul className="list-disc pl-5 text-xs text-muted-foreground">
                {a.questions.map((q: string) => (
                  <li key={q}>{q}</li>
                ))}
              </ul>
            )}
            <Checks checks={c} />
          </div>
        );
      })}
      {edited.length > 0 && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!can || pending}
            onClick={() =>
              start(async () => {
                const res = await recheckMapping(
                  workspaceId,
                  step.id,
                  edited.map((a: any) => ({
                    archetype: a.archetype,
                    source_sql: sql[a.archetype],
                  })),
                );
                setMsg(res.ok ? "Re-checked as a new proposal." : res.error);
                router.refresh();
              })
            }
          >
            {pending ? (
              <LoaderCircle className="animate-spin" />
            ) : (
              <RotateCcw />
            )}{" "}
            Re-check {edited.length} edited
          </Button>
          {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
        </div>
      )}
    </div>
  );
}

export function OrgView({ out }: { out: any }) {
  const children = (ref: string) =>
    out.roles.filter((r: any) => r.parent_ref === ref);
  const node = (r: any, depth: number): React.ReactNode => (
    <li key={r.ref}>
      <div
        className="flex flex-wrap items-baseline gap-2 py-1"
        style={{ paddingLeft: depth * 18 }}
      >
        <span className="font-medium">{r.title}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {r.archetype}
          {r.department && ` · ${r.department}`}
        </span>
        <span className="text-xs text-muted-foreground">{r.why}</span>
      </div>
      <ul>{children(r.ref).map((c: any) => node(c, depth + 1))}</ul>
    </li>
  );
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {out.departments.map((d: any) => (
          <Badge key={d.name} tone="ok">
            {d.name} · {d.playbook} · head {d.head_ref}
          </Badge>
        ))}
      </div>
      <ul className="rounded-xl bg-surface p-3">
        {out.roles
          .filter((r: any) => !r.parent_ref)
          .map((r: any) => node(r, 0))}
      </ul>
      {out.notes.length > 0 && (
        <ul className="list-disc pl-5 text-xs text-muted-foreground">
          {out.notes.map((n: string) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function MetricsView({ step }: { step: OnboardingStep }) {
  const out = step.output as any;
  const dry = (step.checks?.dry_runs ?? {}) as Record<string, any>;
  return (
    <div className="space-y-3 text-sm">
      {out.metrics.map((m: any) => {
        const d = dry[m.template] ?? {};
        return (
          <div key={m.key} className="space-y-2 rounded-xl bg-surface p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{m.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">
                {m.template} v{m.template_version} · {m.unit} ·{" "}
                {m.higher_is_better ? "higher is better" : "lower is better"}
              </span>
            </div>
            <p className="text-xs">
              <span className="font-medium">
                Money per unit: {m.unit_value}
              </span>{" "}
              <span className="text-muted-foreground">
                {m.unit_value_basis}
              </span>
            </p>
            {d.entities !== undefined && (
              <p className="text-xs text-muted-foreground">
                Dry run: {num(d.entities)} entities × {num(d.weeks)} weeks ({num(d.rows)} rows
                {d.rows_needed_vs_workspace_cap &&
                !d.rows_needed_vs_workspace_cap.fits
                  ? `, above the ${num(d.rows_needed_vs_workspace_cap.row_cap)}-row cap`
                  : ""}
                ) · median history {d.weeks_per_entity_median} weeks
              </p>
            )}
            {d.error && (
              <p className="text-xs text-brand">Dry run failed: {d.error}</p>
            )}
            <table className="w-full text-xs">
              <thead className="text-left text-muted-foreground">
                <tr>
                  <th className="p-1">Role</th>
                  <th className="p-1">Weight</th>
                  <th className="p-1">Threshold</th>
                  <th className="p-1">Daily</th>
                  <th className="p-1">Why</th>
                </tr>
              </thead>
              <tbody>
                {m.attach.map((a: any) => (
                  <tr
                    key={a.role_ref}
                    className="border-t border-border/40 align-top"
                  >
                    <td className="p-1 font-mono">{a.role_ref}</td>
                    <td className="p-1 tabular-nums">{a.weight}</td>
                    <td className="p-1">
                      {a.threshold.kind === "none"
                        ? "trend only"
                        : `${num(a.threshold_value)} (${a.threshold.kind} ${num(a.threshold.value)})`}
                      <div className="text-muted-foreground">
                        {a.threshold.basis}
                      </div>
                    </td>
                    <td className="p-1">{a.daily_check ? "yes" : "no"}</td>
                    <td className="p-1">{a.why}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      {out.skipped.length > 0 && (
        <Section title="Not turned on">
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {out.skipped.map((s: any) => (
              <li key={s.template}>
                <span className="font-mono">{s.template}</span>: {s.reason}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

export function RulesView({ out }: { out: any }) {
  return (
    <div className="space-y-3 text-sm">
      <table className="w-full text-xs">
        <thead className="text-left text-muted-foreground">
          <tr>
            <th className="p-1.5">Setting</th>
            <th className="p-1.5">Now</th>
            <th className="p-1.5">Proposed</th>
            <th className="p-1.5">Reason</th>
          </tr>
        </thead>
        <tbody>
          {out.changes.map((c: any) => (
            <tr key={c.key} className="border-t border-border/40 align-top">
              <td className="p-1.5 font-mono">{c.key}</td>
              <td className="p-1.5 tabular-nums">{num(c.current)}</td>
              <td className="p-1.5 font-semibold tabular-nums">
                {num(c.clean_value ?? c.value)}
              </td>
              <td className="p-1.5">{c.reason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {out.kept.length > 0 && (
        <Section title="Kept on purpose">
          <ul className="list-disc pl-5 text-xs text-muted-foreground">
            {out.kept.map((k: any) => (
              <li key={k.key}>
                <span className="font-mono">{k.key}</span>: {k.why}
              </li>
            ))}
          </ul>
        </Section>
      )}
      {out.risks.length > 0 && (
        <Section title="Risks">
          <ul className="list-disc pl-5 text-xs">
            {out.risks.map((r: string) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

/** The grants a customer's Snowflake admin runs to create the read-only role (names from the form). */
function roleSetupSql(c: OnboardingState["connection"]) {
  const q = (v: string | undefined, fallback: string) => `"${(v || fallback).replace(/"/g, "")}"`;
  const role = q(c?.role_name, "FORMADA_READER");
  const db = q(c?.database_name, "YOUR_DATABASE");
  const lines = [
    `CREATE ROLE IF NOT EXISTS ${role};`,
    `GRANT USAGE ON WAREHOUSE ${q(c?.warehouse_name, "FORMADA_WH")} TO ROLE ${role};`,
    `GRANT USAGE ON DATABASE ${db} TO ROLE ${role};`,
  ];
  for (const name of c?.schemas?.length ? c.schemas : ["YOUR_SCHEMA"]) {
    const schema = `${db}.${q(name, "YOUR_SCHEMA")}`;
    lines.push(
      `GRANT USAGE ON SCHEMA ${schema} TO ROLE ${role};`,
      `GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ROLE ${role};`,
      `GRANT SELECT ON ALL VIEWS IN SCHEMA ${schema} TO ROLE ${role};`,
    );
  }
  lines.push(`GRANT ROLE ${role} TO USER ${q(c?.user_name, "FORMADA_SVC")};`);
  return lines.join("\n");
}

function RoleSetupExample({ connection }: { connection: OnboardingState["connection"] }) {
  const [copied, setCopied] = useState(false);
  const sql = roleSetupSql(connection);
  return (
    <details className="role-setup" open>
      <summary>
        <Icon name="key" size={17} /> <span>View example role setup</span>
        <Icon name="chevron-down" size={16} />
      </summary>
      <p>Your customer&apos;s Snowflake administrator can run this when preparing the read-only role.</p>
      <div className="role-setup-code">
        <pre>{sql}</pre>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() =>
            navigator.clipboard
              .writeText(sql)
              .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
              .catch(() => undefined)
          }
        >
          <Icon name={copied ? "check" : "copy"} size={15} /> {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </details>
  );
}

export function ConnectStep({
  state,
  can,
}: {
  state: OnboardingState;
  can: boolean;
}) {
  const router = useRouter();
  const c = state.connection;
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  function submit(form: FormData) {
    const body = Object.fromEntries(form.entries());
    start(async () => {
      const res = await saveConnection(state.workspace.id, {
        ...body,
        schemas: String(body.schemas ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
        monthly_credit_cap: Number(body.monthly_credit_cap || 25),
      });
      setMsg(
        res.ok
          ? res.data?.ok
            ? "Connected."
            : `Test failed: ${res.data?.error}`
          : res.error,
      );
      router.refresh();
    });
  }
  // The design shows five fields; the rest sit under "Advanced" (still part of the same form).
  const fields: [string, string, string][] = [
    ["account_identifier", "Account identifier", c?.account_identifier ?? ""],
    ["warehouse_name", "Warehouse", c?.warehouse_name ?? ""],
    ["database_name", "Database", c?.database_name ?? ""],
    ["schemas", "Schemas", c?.schemas.join(", ") ?? ""],
    ["role_name", "Read-only role", c?.role_name ?? ""],
  ];
  const advanced: [string, string, string][] = [
    ["user_name", "Service user", c?.user_name ?? ""],
    ["secret_ref", "Vault key reference", c?.secret_ref ?? ""],
    ["monthly_credit_cap", "Monthly credit cap", String(c?.monthly_credit_cap ?? 25)],
  ];
  const passed = c?.status === "ok";
  return (
    <>
      <section className="stage-panel connection-panel">
        <div className="connection-story">
          <div className="connection-copy">
            <span className={`stage-badge ${passed ? "positive" : "attention"}`}>
              {passed && <Icon name="check" size={13} />}
              {passed ? "Connection verified" : c?.status === "failed" ? "Test failed" : "Awaiting setup"}
            </span>
            <h2>
              Connect the data
              <br className="connection-break" /> warehouse.
            </h2>
            <p>Set up read-only access to the Snowflake data this workspace will use.</p>
          </div>
          <ConnectionGraphic verified={passed} readOnly="Read-only access" />
        </div>
        <div className="connection-foot">
          <span>
            <Icon name="shield" size={17} /> Read-only access
          </span>
          <span>
            <Icon name="key" size={16} /> Key-pair authentication, key kept in the vault
          </span>
          <span>
            <Icon name="database" size={17} /> Snowflake
          </span>
        </div>
      </section>
      <section className="stage-panel stage-content-panel">
        <div className="stage-panel-heading">
          <span className="stage-heading-icon">
            <Icon name="database" size={19} />
          </span>
          <div>
            <h3>Connection settings</h3>
            <p>Verify the scoped connection before starting discovery.</p>
          </div>
        </div>
        {state.lab && (
          <div className="snapshot-picker">
            <div className="snapshot-head">
              <strong>Warehouse snapshot</strong>
              <p>
                The lab replays a saved copy of the customer&apos;s warehouse (names, types and counts, never rows).
                Pick the one this review works on.
              </p>
            </div>
            {state.lab.items.length === 0 && (
              <p className="stage-helper">No snapshot is loaded yet. Ask the lab owner to load one.</p>
            )}
            <ul>
              {state.lab.items.map((s) => {
                const on = state.lab?.selected === s.id;
                return (
                  <li key={s.id}>
                    <button
                      type="button"
                      className={cn("snapshot-card", on && "on")}
                      aria-pressed={on}
                      disabled={!can || pending}
                      onClick={() =>
                        start(async () => {
                          const res = await selectSnapshot(state.workspace.id, s.id);
                          setMsg(res.ok ? "Snapshot selected." : res.error);
                          router.refresh();
                        })
                      }
                    >
                      <span className="snapshot-radio">{on && <Icon name="check" size={13} />}</span>
                      <span className="snapshot-body">
                        <strong>
                          {s.database ?? "Warehouse"}
                          {s.recommended && <span className="stage-badge positive">Recommended: best version</span>}
                        </strong>
                        <span>
                          {s.tables} tables · {s.views} semantic views
                          {s.guide ? ` · guide from ${s.guide}` : ""} · saved{" "}
                          {new Date(s.saved_at).toLocaleDateString("en-CA")}
                        </span>
                        {s.summary && <span className="snapshot-sum">{s.summary}</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {state.mock_connection && can && (
          <div className="discovery-semantic">
            <div>
              <strong>{state.lab ? "Connect to the example warehouse" : "Local mock warehouse"}</strong>
              <p>
                {state.lab
                  ? "The connection is simulated: it passes the test and uses the snapshot selected above. DavidsTea is always available as the live example."
                  : "One click fills and tests the connection (preset in .env)."}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              disabled={pending}
              onClick={() =>
                start(async () => {
                  const res = await connectMockWarehouse(state.workspace.id);
                  setMsg(
                    res.ok
                      ? res.data?.ok
                        ? "Connected to the mock warehouse."
                        : `Test failed: ${res.data?.error}`
                      : res.error,
                  );
                  router.refresh();
                })
              }
            >
              {pending ? <LoaderCircle className="animate-spin" /> : <Icon name="play" size={17} />}
              <span>{state.lab ? "Connect to DavidsTea" : "Use the mock warehouse"}</span>
            </button>
          </div>
        )}
        <form action={submit} className="stage-form">
          <div className="stage-fields">
            {fields.map(([name, label, value]) => (
              <label key={name}>
                {label}
                <input name={name} defaultValue={value} autoComplete="off" disabled={!can} />
              </label>
            ))}
          </div>
          <details className="connection-advanced">
            <summary>
              <span>Advanced settings</span>
              <Icon name="chevron-down" size={16} />
            </summary>
            <div className="stage-fields">
              {advanced.map(([name, label, value]) => (
                <label key={name}>
                  {label}
                  <input name={name} defaultValue={value} autoComplete="off" disabled={!can} />
                </label>
              ))}
            </div>
          </details>
          <div className="stage-form-footer">
            <button type="submit" className="btn btn-primary" disabled={!can || pending}>
              {pending ? <LoaderCircle className="animate-spin" /> : <Icon name="activity" size={17} />}
              <span>{passed ? "Test again" : "Test connection"}</span>
            </button>
            {passed && (
              <span className="stage-badge positive">
                <Icon name="check" size={13} /> Connection test passed
              </span>
            )}
            {c?.test_result?.error && <span className="stage-helper">{c.test_result.error}</span>}
            {msg && <span className="stage-helper">{msg}</span>}
          </div>
          <RoleSetupExample connection={c} />
          <p className="stage-helper">
            The key itself never goes here: it lives in the vault under the reference. Locally the connection points at the fakesnow warehouse.
          </p>
        </form>
      </section>
    </>
  );
}
