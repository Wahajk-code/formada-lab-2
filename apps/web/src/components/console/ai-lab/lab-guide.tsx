"use client";
/* eslint-disable @typescript-eslint/no-explicit-any -- agent inputs and answers are schema-checked JSON */

import { Layers } from "lucide-react";

import { Peek } from "@/components/console/ai-lab/lab-shared";
import { DataGuide } from "@/components/console/onboarding/data-guide";
import { RelationshipMap } from "@/components/console/ai-lab/relationship-map";
import { Pill } from "@/components/onboarding/tone";
import type { LabRun, OnboardingGuide } from "@/lib/console-api";

const num = (v: number) => v.toLocaleString("en-CA");

const USE: Record<string, { label: string; tone: "good" | "matched" | "neutral" }> = {
  map_from_view: { label: "Map from the view", tone: "good" },
  map_from_tables: { label: "Map from the tables", tone: "matched" },
  reference_only: { label: "Reference only", tone: "neutral" },
};

/** What the semantic view tells us for free, and what only our own profile can add. */
function Contrast({ profile }: { profile: any }) {
  const views: any[] = profile?.semantic_views ?? [];
  const metrics = views.reduce((s, v) => s + v.tables.reduce((a: number, t: any) => a + t.metrics.length, 0), 0);
  const links = views.reduce((s, v) => s + v.relationships.length, 0);
  const joins: any[] = profile?.joins ?? [];
  const rows: [string, string, string][] = [
    ["What a field means", "Yes: every field carries a plain-words comment the customer's team wrote.", "Only a name and a type. The agent guesses the meaning."],
    ["What a measure is", `Yes: ${num(metrics)} named measures with their formula (net sales, units, discounts…).`, "No. We would have to infer it."],
    ["How tables join", `Declared: ${num(links)} relationships, written by the customer.`, `Tested on the data: ${joins.filter((j) => j.confirmed).length} of ${joins.length} candidate joins confirmed.`],
    ["How much data, how fresh", "No. A view holds no counts, dates or history.", "Row counts, first and last date, cadence and breaks."],
    ["Is the data trustworthy", "No. It cannot show gaps, duplicates, carried-forward rows or empty columns.", "Fill rates, repeated keys, twin tables, category mix over time."],
    ["Can we read it", "Yes, even where the base tables are hidden from our role.", "Only the tables our role can see."],
  ];
  return (
    <div className="overflow-x-auto rounded-2xl bg-surface">
      <table className="w-full text-left text-xs">
        <thead className="text-muted-foreground">
          <tr>
            <th className="px-3 py-2 font-medium">The question</th>
            <th className="px-3 py-2 font-medium">The customer&apos;s semantic view</th>
            <th className="px-3 py-2 font-medium">Our profile</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([q, a, b]) => (
            <tr key={q} className="border-t border-border/50 align-top">
              <td className="px-3 py-2 font-semibold">{q}</td>
              <td className="px-3 py-2">{a}</td>
              <td className="px-3 py-2">{b}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ViewCard({ v, said }: { v: any; said: any | undefined }) {
  const facts = v.tables.filter((t: any) => t.metrics.length);
  const metricCount = facts.reduce((a: number, t: any) => a + t.metrics.length, 0);
  const dimCount = v.tables.reduce((a: number, t: any) => a + (t.dimension_count ?? t.dimensions.length), 0);
  return (
    <article className="space-y-3 rounded-2xl bg-card p-4 shadow-sm">
      <header className="flex flex-wrap items-center gap-2">
        <span className="grid size-8 place-items-center rounded-full bg-foreground text-background">
          <Layers className="size-4" aria-hidden />
        </span>
        <h4 className="font-mono text-sm font-semibold">{v.view}</h4>
        {said && <Pill tone={USE[said.use_for]?.tone ?? "neutral"}>{USE[said.use_for]?.label ?? said.use_for}</Pill>}
      </header>
      <dl className="source-totals">
        <div><dt>Tables</dt><dd>{v.tables.length}{v.tables_not_shown ? <small> +{v.tables_not_shown}</small> : null}</dd></div>
        <div><dt>Dimensions</dt><dd>{num(dimCount)}</dd></div>
        <div><dt>Measures</dt><dd>{num(metricCount)}</dd></div>
        <div><dt>Links</dt><dd>{v.relationships.length}</dd></div>
      </dl>
      {said && (
        <div className="space-y-1.5 text-sm">
          <p>{said.purpose}</p>
          <p className="text-xs text-muted-foreground"><b className="text-foreground">One row is: </b>{said.grain}</p>
          <div className="flex flex-wrap gap-1.5">
            {said.families.map((f: string) => <Pill key={f} tone="matched">{f.replaceAll("_", " ")}</Pill>)}
          </div>
          {said.caveats?.length > 0 && (
            <ul className="space-y-1 text-xs">
              {said.caveats.map((c: string, i: number) => <li key={i} className="rounded-lg bg-surface px-2.5 py-1.5">{c}</li>)}
            </ul>
          )}
        </div>
      )}
      <div className="space-y-1.5">
        <p className="text-xs font-semibold text-muted-foreground">Measures the customer defined</p>
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {facts.slice(0, 4).flatMap((t: any) => t.metrics.slice(0, 5).map((m: any) => ({ t: t.table, m }))).slice(0, 12).map(({ t, m }: any) => (
            <li key={`${t}.${m.name}`} className="rounded-xl bg-surface p-2.5 text-xs">
              <p className="font-semibold">{m.name.replaceAll("_", " ").toLowerCase()}</p>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground break-words">{m.expression}</p>
              <p className="mt-0.5 text-[10px] text-muted-foreground">on {t}</p>
            </li>
          ))}
        </ul>
      </div>
      <Peek title="Everything the profile says about this view" hint="tables, fields, measures, links" value={v} />
    </article>
  );
}


/** The answer first: what data this is, how much, how fresh, what it can measure, what to watch. */
function AtAGlance({ out, profile }: { out: any; profile: any }) {
  const tables: any[] = profile?.tables ?? [];
  const biggest = tables.reduce((m: any, t: any) => ((t.rows ?? 0) > (m?.rows ?? 0) ? t : m), null);
  const days: any[] = profile?.time_profile?.by_date ?? [];
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;
  const high = (out.quality_issues ?? []).filter((q: any) => q.severity === "high");
  const rank: Record<string, number> = { high: 0, medium: 1, low: 2 };
  const top = [...(out.quality_issues ?? [])].sort((a: any, b: any) => rank[a.severity] - rank[b.severity]).slice(0, 3);
  const tone = (st: string) => (st === "present" ? "good" : st === "partial" ? "partial" : "missing");
  const areas = (out.coverage ?? []).filter((c: any) => ["sales", "inventory", "purchase_orders", "returns", "vendors", "customers"].includes(c.family));
  return (
    <section className="space-y-4 rounded-2xl bg-card p-5 shadow-sm">
      <div>
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-muted-foreground">At a glance</p>
        <p className="mt-1 max-w-3xl text-base leading-relaxed">{out.summary}</p>
      </div>
      {(out.measured_after_mapping ?? []).length > 0 && (
        <div className="rounded-xl bg-surface p-3 text-xs">
          <p className="font-semibold">Measured on the real data after mapping</p>
          <ul className="mt-1 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {out.measured_after_mapping.map((m: any) => (
              <li key={m.shape} className="flex justify-between gap-3">
                <span>{m.shape.replaceAll("_", " ")}</span>
                <span className="text-muted-foreground">{num(m.rows)} rows{m.first_date ? ` · ${m.first_date} → ${m.last_date}` : ""}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <dl className="source-totals">
        <div><dt>Main table</dt><dd>{biggest ? num(biggest.rows) : "–"}<small> rows</small></dd></div>
        <div><dt>History</dt><dd className="text-base">{first && last ? `${first} → ${last}` : "–"}</dd></div>
        <div><dt>Tables read</dt><dd>{tables.length}<small> + {(profile?.semantic_views ?? []).length} views</small></dd></div>
        <div><dt>High risks</dt><dd>{high.length}</dd></div>
      </dl>
      <div className="space-y-2">
        <p className="text-xs font-semibold text-muted-foreground">What we can measure</p>
        <div className="flex flex-wrap gap-2">
          {areas.map((c: any) => (
            <Pill key={c.family} tone={tone(c.status)}>
              {c.family.replaceAll("_", " ")}: {c.status}
            </Pill>
          ))}
        </div>
      </div>
      {top.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">Three things to know before trusting a number</p>
          <ol className="space-y-1.5 text-sm">
            {top.map((q: any, i: number) => (
              <li key={i} className="flex gap-2">
                <span className="mt-0.5 grid size-5 shrink-0 place-items-center rounded-full bg-foreground text-[11px] font-bold text-background">{i + 1}</span>
                <span><b>{q.title}.</b> <span className="text-muted-foreground">{q.suggested_handling}</span></span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

/** The data guide in full, plus what the customer's semantic views add to it. */
export function LabGuide({ run, guide, wsId }: { run: LabRun | undefined; guide: OnboardingGuide | null; wsId: string | null }) {
  const out = run?.output;
  if (!out?.tables) {
    return <p className="rounded-xl bg-surface p-4 text-sm text-muted-foreground">No data guide yet. Run discovery on this workspace first.</p>;
  }
  const profile = run?.input?.profile;
  const views: any[] = profile?.semantic_views ?? [];
  const said: any[] = out.semantic_views ?? [];
  return (
    <div className="space-y-8">
      <AtAGlance out={out} profile={profile} />
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">The data guide</h3>
        <DataGuide out={out} guide={guide} workspaceId={wsId ?? ""} can={false} showSummary={false} />
      </section>
      {views.length > 0 && (
        <details open className="group space-y-3">
          <summary className="cursor-pointer list-none text-sm font-semibold">
            How the customer&apos;s own data model connects the tables
            <span className="ml-2 text-xs font-normal text-muted-foreground">their semantic views: tables, links and measures</span>
          </summary>
          <p className="max-w-3xl text-xs text-muted-foreground">
            Snowflake lets a team write down what its data means. We read that for free: it says what each field is and how tables connect.
            It cannot say whether the data is complete or trustworthy. Our checks above do that.
          </p>
          {views.map((v) => (
            <div key={`map-${v.view}`} className="space-y-2">
              <h4 className="font-mono text-xs font-semibold">{v.view}</h4>
              <RelationshipMap view={v} />
            </div>
          ))}
          <div className="grid gap-4 lg:grid-cols-2">
            {views.map((v) => (
              <ViewCard key={v.view} v={v} said={said.find((s) => String(s.view).toUpperCase() === String(v.view).toUpperCase())} />
            ))}
          </div>
          <Contrast profile={profile} />
        </details>
      )}
    </div>
  );
}
