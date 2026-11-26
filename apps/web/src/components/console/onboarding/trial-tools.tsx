"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { applyRulesPreset, previewChange, rateTrialCard } from "@/app/console-actions";
import { PRESETS, type PresetName } from "@/components/console/onboarding/rules-presets";
import { Status } from "@/components/console/onboarding/review-kit";
import { Icon } from "@/components/ui/icon";
import type { CardFull } from "@/lib/client-api";
import type { PreviewResult } from "@/lib/console-api";
import { whyCard } from "@/lib/trial-why";
import { cn } from "@/lib/utils";

const RATINGS = [
  { key: "useful", label: "Useful", needsNote: false, help: "Keep writing cards like this" },
  { key: "not_relevant", label: "Not relevant", needsNote: false, help: "Proposes a rule to give this measure less weight for this role" },
  { key: "impossible", label: "Cannot act", needsNote: true, help: "Proposes a rule never to suggest this exact problem to this role" },
  { key: "wrong_number", label: "Wrong number", needsNote: true, help: "A data problem: check the mapping. No rule is proposed" },
] as const;

/**
 * Under each trial card: why it exists (the rule that let it through and what to change to get fewer or
 * more like it), and a rating. Not relevant and Cannot act propose a rule that waits in Rule review; they
 * change nothing by themselves.
 */
export function TrialCardReview({ workspaceId, card, can }: { workspaceId: string; card: CardFull; can: boolean }) {
  const why = whyCard(card);
  const [pending, start] = useTransition();
  const [note, setNote] = useState("");
  const [picked, setPicked] = useState<(typeof RATINGS)[number]["key"] | null>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const choice = RATINGS.find((r) => r.key === picked);
  const send = () => {
    if (!picked) return;
    start(async () => {
      const res = await rateTrialCard(workspaceId, card.id, picked, note);
      setResult(res.ok ? { ok: true, text: res.data?.message ?? "Saved." } : { ok: false, text: res.error });
      if (res.ok) setPicked(null);
    });
  };
  return (
    <details className="stage-disclosure trial-review">
      <summary>
        <span>Why this card, and rate it</span>
        <Icon name="chevron-down" size={15} />
      </summary>
      <div className="trial-review-body">
        <ul className="rv-list">
          {why.reasons.map((r) => (
            <li key={r}>{r}</li>
          ))}
        </ul>
        {why.tune.length > 0 && (
          <>
            <p className="rv-muted">To change how many cards like this appear:</p>
            <ul className="rv-list">
              {why.tune.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </>
        )}
        {can && (
          <div className="trial-rate">
            <div className="trial-rate-buttons" role="group" aria-label="Rate this card">
              {RATINGS.map((r) => (
                <button key={r.key} type="button" aria-pressed={picked === r.key} title={r.help} className={cn("btn btn-secondary", picked === r.key && "is-on")} disabled={pending} onClick={() => setPicked(picked === r.key ? null : r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
            {choice && (
              <div className="trial-rate-note">
                <p className="rv-muted">{choice.help}.</p>
                <input value={note} maxLength={500} placeholder={choice.needsNote ? "Say why, in a few words (required)" : "Why? (optional)"} onChange={(e) => setNote(e.target.value)} aria-label="Why" />
                <button type="button" className="btn btn-primary" disabled={pending || (choice.needsNote && !note.trim())} onClick={send}>
                  <Icon name="check" size={15} /> <span>{pending ? "Saving…" : "Save rating"}</span>
                </button>
              </div>
            )}
            {result && (
              <p className={cn("rv-alert", !result.ok && "rv-alert-fail")} role="status">
                {result.text}
              </p>
            )}
          </div>
        )}
      </div>
    </details>
  );
}

type Row = { role: string; now: number; counts: Partial<Record<PresetName, number>> };

/**
 * How many cards each setting would give each role, replayed on the trial run (the same preview as in
 * Config & rules). Pick the volume with the numbers in front of you, apply it, and run the trial again.
 */
export function TrialTune({ workspaceId, can, currency }: { workspaceId: string; can: boolean; currency: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  const names = Object.keys(PRESETS) as PresetName[];

  useEffect(() => {
    let stop = false;
    void (async () => {
      const results: Partial<Record<PresetName, PreviewResult>> = {};
      for (const name of names) {
        const p = PRESETS[name];
        const res = await previewChange(workspaceId, { min_signal_impact: p.min_signal_impact, max_open_cards_per_role: p.max_open_cards_per_role, top_signals_per_role: p.top_signals_per_role }, {});
        if (stop) return;
        if (!res.ok || !res.data) {
          setError(res.ok ? "No preview." : res.error);
          return;
        }
        results[name] = res.data;
      }
      const first = results[names[0]]!;
      setRows(first.roles.map((r, i) => ({ role: r.role, now: r.before, counts: Object.fromEntries(names.map((n) => [n, results[n]!.roles[i]?.after ?? 0])) })));
    })();
    return () => {
      stop = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the presets are constants
  }, [workspaceId]);

  const money = (v: number) => new Intl.NumberFormat("en-CA", { style: "currency", currency, maximumFractionDigits: 0 }).format(v);
  const total = (f: (r: Row) => number) => rows?.reduce((n, r) => n + f(r), 0) ?? 0;
  return (
    <div className="trial-insight-section">
      <h4>How many cards each setting would give</h4>
      <p className="rv-muted">Replayed on this run. &ldquo;Now&rdquo; is what your current settings gave. Apply a setting, then run the trial again to see the cards.</p>
      {error ? (
        <p className="stage-helper">{error}</p>
      ) : !rows ? (
        <p className="stage-helper">Counting…</p>
      ) : (
        <div className="stage-table-scroll">
          <table className="stage-table rv-compact">
            <thead>
              <tr>
                <th scope="col">Role</th>
                <th scope="col">Now</th>
                {names.map((n) => (
                  <th key={n} scope="col">
                    {PRESETS[n].label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.role}>
                  <td>{r.role}</td>
                  <td>{r.now}</td>
                  {names.map((n) => (
                    <td key={n} className={cn(r.counts[n] === 0 && "rv-muted")}>
                      {r.counts[n]}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="rv-total">
                <td>
                  <b>All roles</b>
                </td>
                <td>
                  <b>{total((r) => r.now)}</b>
                </td>
                {names.map((n) => (
                  <td key={n}>
                    <b>{total((r) => r.counts[n] ?? 0)}</b>
                  </td>
                ))}
              </tr>
              {can && (
                <tr>
                  <td />
                  <td />
                  {names.map((n) => (
                    <td key={n}>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={pending}
                        title={`${PRESETS[n].help}: over ${money(PRESETS[n].min_signal_impact)}, up to ${PRESETS[n].max_open_cards_per_role} cards each`}
                        onClick={() =>
                          start(async () => {
                            const res = await applyRulesPreset(workspaceId, n);
                            setMsg(res.ok ? `${PRESETS[n].label} applied. Run the trial again to see the cards.` : res.error);
                            router.refresh();
                          })
                        }
                      >
                        Use {PRESETS[n].label}
                      </button>
                    </td>
                  ))}
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
      {msg && <Status tone="info">{msg}</Status>}
    </div>
  );
}
