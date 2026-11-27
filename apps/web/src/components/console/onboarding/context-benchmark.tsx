"use client";

import type { CardCtx } from "@/components/console/onboarding/card-tools";
import { FactBar, Fold, Section, Status } from "@/components/console/onboarding/review-kit";
import { cn } from "@/lib/utils";

const bare = (t: string) => t.replace(/[.\s]+$/, "");

type Probe = { id: string; group: string; title: string; expected: string; found: string; status: "pass" | "fail" | "skip" };
export type Benchmark = { verdict: "confirmed" | "mostly" | "doubtful"; score: number; passed: number; total: number; failed: number; critical: number; probes: Probe[] };

const VERDICT = {
  confirmed: { tone: "ready", word: "Context confirmed" },
  mostly: { tone: "partial", word: "Mostly right" },
  doubtful: { tone: "fail", word: "Doubtful" },
} as const;

/**
 * A benchmark on what the AI chose by itself. Code works out the right answer for obvious things from
 * what the scan measured (the main table of each view, which areas a view feeds, that every measure it
 * lists exists, how often the data arrives) and compares it with what the AI wrote. Right on all of
 * them is evidence it read its context properly. Wrong on one it made up is a reason to rerun before
 * trusting the harder parts. It costs nothing: no AI is involved, and it updates with every edit.
 */
export function ContextBenchmark({ benchmark, cards, subject = "discovery", onExplain }: { benchmark?: Benchmark | null; cards?: CardCtx; subject?: "discovery" | "mapping" | "org" | "metrics" | "rules"; onExplain?: (question: string) => void }) {
  if (!benchmark || benchmark.total === 0) return null;
  const v = VERDICT[benchmark.verdict];
  const failed = benchmark.probes.filter((p) => p.status === "fail");
  const passed = benchmark.probes.filter((p) => p.status === "pass");
  const groups = [...new Set(passed.map((p) => p.group))];
  const what = subject === "mapping" ? "the mapping" : subject === "org" ? "the org web" : subject === "metrics" ? "the metrics plan" : subject === "rules" ? "the rules" : "the analysis";
  const point =
    benchmark.verdict === "confirmed"
      ? `Code worked out the obvious answers from what was measured, and the AI got every one right. That is evidence it read ${subject === "mapping" ? "the customer's fields" : subject === "org" ? "the roles and the data" : subject === "metrics" ? "the roles, the templates and the data" : "the data"} properly.`
      : benchmark.verdict === "mostly"
        ? "The AI got the obvious answers right except the ones below. Check them: they are small, but they show where it read loosely."
        : `The AI got something obvious wrong, or made something up. Run ${what} again, or fix the items below, before trusting the harder parts.`;
  const explain = () => {
    if (onExplain) {
      onExplain(`Explain these failed checks in plain words and say how to fix each one: ${failed.map((p) => `${p.title} (expected ${bare(p.expected)}; found ${bare(p.found)})`).join("; ")}`);
    } else {
      cards?.onExplain?.("f:benchmark");
    }
  };
  return (
    <Section id="rv-benchmark" icon="check-circle" title="Does the AI have the right context?" point={point} tools={subject === "discovery" && cards && <FactBar id="f:benchmark" ctx={cards} note="Checked by code" />}>
      <div className="bm-head">
        <Status tone={v.tone}>
          {v.word}: {benchmark.passed} of {benchmark.total} right
        </Status>
        <span className="rv-muted">{benchmark.verdict === "confirmed" ? "No AI was used for this check." : `${benchmark.failed} to look at${benchmark.critical ? `, ${benchmark.critical} made up` : ""}.`}</span>
      </div>
      <div className="bm-bar" role="img" aria-label={`${benchmark.passed} of ${benchmark.total} checks right`}>
        <span className={cn("bm-fill", `bm-${benchmark.verdict}`)} style={{ width: `${benchmark.score}%` }} />
      </div>

      {failed.length > 0 && (
        <ul className="bm-list">
          {failed.map((p) => (
            <li key={p.id} className="bm-fail">
              <b>{p.title}</b>
              <span>
                Expected: {bare(p.expected)}. Found: {bare(p.found)}.
              </span>
              {(cards?.onExplain || onExplain) && (
                <button type="button" className="card-explain" onClick={explain} title="Ask the assistant what this means and how to fix it">
                  Explain
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {passed.length > 0 && (
        <Fold title={`Show the ${passed.length} checks that passed`}>
          {groups.map((g) => (
            <div key={g} className="rv-block">
              <p className="bm-group">{g}</p>
              <ul className="bm-list">
                {passed
                  .filter((p) => p.group === g)
                  .map((p) => (
                    <li key={p.id} className="bm-pass">
                      <b>{p.title}</b>
                      <span>
                        {bare(p.expected)}: {bare(p.found)}.
                      </span>
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </Fold>
      )}
    </Section>
  );
}
