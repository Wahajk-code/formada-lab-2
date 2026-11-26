/* eslint-disable @typescript-eslint/no-explicit-any -- agent outputs are schema-checked JSON */
import { WORDS } from "@/components/console/onboarding/mapping-guide";
import { Section, Status, type Tone } from "@/components/console/onboarding/review-kit";
import type { OnboardingGuide, OnboardingState } from "@/lib/console-api";

/**
 * Which roles on the org web will have data. Each role type reads certain standard shapes (a buyer
 * reads purchase orders, a sales lead reads sales lines); Mapping says which of those shapes work.
 * So before anyone names the owners, the team can see which roles will get cards and which will
 * wait for data, and what exactly they wait for. Built from the state and the guide alone.
 */

// What a role type must have to get cards (core), and what only adds to them (extra). A missing
// extra shape does not stop a role: a sales lead needs sales lines, not wholesale orders.
export const CORE: Record<string, string[]> = {
  purchasing: ["purchase_order_line"],
  sales: ["sales_line"],
  inventory: ["inventory_snapshot"],
};
export const EXTRA: Record<string, string[]> = {
  purchasing: ["purchase_order"],
  sales: ["wholesale_order_line"],
  inventory: ["inventory_position"],
};
/** Role types whose job is a different shape from their playbook's. */
export const CORE_FOR_ROLE: Record<string, string[]> = { account_manager: ["wholesale_order_line"], sales_ops: ["sales_line"] };
export const EVERY_CORE = [...new Set(Object.values(CORE).flat())];
export const PLAYBOOK_WORD: Record<string, string> = { purchasing: "Purchasing", sales: "Sales", inventory: "Inventory", executive: "Executive" };

type Verdict = { tone: Tone; word: string; why: string };

const names = (list: string[]) => list.map((s) => WORDS[s] ?? s).join(", ");

/** The shapes that work, from the mapping step's own checks. */
function working(state: OnboardingState): { ready: Set<string>; run: boolean } {
  const step = state.steps.mapping;
  const out: any = step?.output;
  if (!out?.archetypes) return { ready: new Set(), run: false };
  const checks: Record<string, any> = step?.checks?.archetypes ?? {};
  const ready = new Set<string>();
  for (const a of out.archetypes as any[]) if (a.status !== "unmappable" && checks[a.archetype]?.ok) ready.add(a.archetype);
  return { ready, run: true };
}

function verdict(core: string[], extra: string[], ready: Set<string>, run: boolean): Verdict {
  if (!run) return { tone: "missing", word: "Mapping not run", why: "Mapping has not produced a result yet." };
  const lack = core.filter((s) => !ready.has(s));
  const skipped = extra.filter((s) => !ready.has(s));
  const note = skipped.length ? ` Not available, and not needed: ${names(skipped)}.` : "";
  if (!lack.length) return { tone: "ready", word: "Will have data", why: note.trim() };
  if (lack.length === core.length) return { tone: "fail", word: "No data yet", why: `Waiting for: ${names(lack)}.${note}` };
  return { tone: "partial", word: "Partly there", why: `Still waiting for: ${names(lack)}.${note}` };
}

export function RoleCoverage({ state, guide }: { state: OnboardingState; guide: OnboardingGuide | null }) {
  const roles = state.org.roles;
  if (!roles.length) return null;
  const { ready, run } = working(state);
  const playbookOf = (key: string | null) => guide?.role_archetypes.find((a) => a.key === key)?.playbook ?? null;
  const rows = roles.map((r) => {
    const playbook = playbookOf(r.archetype);
    const core = playbook === "executive" ? EVERY_CORE : ((r.archetype && CORE_FOR_ROLE[r.archetype]) || (playbook ? (CORE[playbook] ?? []) : []));
    const extra = playbook && playbook !== "executive" ? (EXTRA[playbook] ?? []).filter((x) => !core.includes(x)) : [];
    const v: Verdict = playbook ? verdict(core, extra, ready, run) : { tone: "missing", word: "No role type", why: "Give it a role type so it knows what to read." };
    return { r, playbook, core, extra, v };
  });
  const ok = rows.filter((x) => x.v.tone === "ready").length;
  return (
    <Section
      id="rv-role-coverage"
      icon="users"
      title="Which roles will have data"
      point="Each role reads certain data (a buyer reads purchase orders). This shows which roles will get cards from what Mapping confirmed, and what the others are waiting for."
      count={<Status tone={ok === rows.length ? "ready" : "partial"}>{`${ok} of ${rows.length} ready`}</Status>}
    >
      <div className="stage-table-scroll">
        <table className="stage-table rv-compact">
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Type</th>
              <th scope="col">Reads</th>
              <th scope="col">Data</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ r, playbook, core, extra, v }) => (
              <tr key={r.id}>
                <td>
                  <b>{r.title}</b>
                  <small className="rv-muted"> {r.holder_type === "vacant" ? "· vacant" : ""}</small>
                </td>
                <td>{playbook ? (PLAYBOOK_WORD[playbook] ?? playbook) : "–"}</td>
                <td>{playbook === "executive" ? "Every area" : core.length ? names(core) : "–"}{extra.length > 0 && <small className="rv-muted"> + {names(extra)}</small>}</td>
                <td>
                  <Status tone={v.tone}>{v.word}</Status>
                  {v.why && <small className="rv-muted rv-why"> {v.why}</small>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}
