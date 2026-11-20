/** Mock readings for the upper-management view (the CEO example design). Fictional company.
 *
 * This is the only file that knows the numbers: `getExecutiveOverview` is the seam. When live data
 * arrives it is replaced by a call to the API with the same return type, and nothing else changes. */

export type Unit = "CAD" | "USD" | "orders" | "days" | "";
export type Period = "year" | "current";

export type Reading = {
  key: string;
  name: string;
  role: string;
  unit: Unit;
  decimals: number;
  value: number;
  prior: number;
  /** value minus prior */
  delta: number;
  lowerIsBetter?: boolean;
  /** "improving" means the move is good for the business (a shorter lead time is improving). */
  trend: "improving" | "attention";
  suggestion?: string;
};

/** One recommended action: a reading that moved the wrong way, with the card the role would read. */
export type Suggestion = {
  id: string;
  title: string;
  department: string;
  role: string;
  metric: string;
  /** Expected impact in CAD (mock: derived from the size of the move). */
  impact: number;
  confidence: number;
  headline: string;
  what: string;
  soWhat: string;
  nowWhat: string;
  current: Reading;
};

export type Department = { id: string; name: string; roles: number; readings: Reading[] };

export type ExecutiveOverview = {
  company: string;
  activeRole: string;
  period: Period;
  year: number;
  kpis: Reading[];
  departments: Department[];
  suggestions: Suggestion[];
};

type Base = { key: string; name: string; unit: Unit; decimals: number; lowerIsBetter?: boolean };
const NET: Base = { key: "net_revenue", name: "Net revenue", unit: "CAD", decimals: 0 };
const UNITS: Base = { key: "units_sold", name: "Units sold", unit: "", decimals: 2 };
const SEG: Base = { key: "revenue_by_segment", name: "Revenue by segment", unit: "USD", decimals: 2 };
const ORDERS: Base = { key: "open_orders_at_risk", name: "Open orders at risk", unit: "orders", decimals: 2, lowerIsBetter: true };
const COVER: Base = { key: "stock_coverage", name: "Stock coverage", unit: "days", decimals: 2 };
const LEAD: Base = { key: "supplier_lead_time", name: "Supplier lead time", unit: "days", decimals: 2, lowerIsBetter: true };

/** Annual readings (this year against last year) and the latest reading (against the period before). */
const YEAR: Record<string, [number, number]> = {
  net_revenue: [15150774, 15119003],
  units_sold: [222933.76, 223549.31],
  revenue_by_segment: [51986.94, 51335.05],
  open_orders_at_risk: [110.85, 109.46],
  stock_coverage: [15.15, 14.96],
  supplier_lead_time: [14.91, 15.2],
};
const CURRENT: Record<string, [number, number]> = {
  net_revenue: [1248000, 1280000],
  units_sold: [18860, 18240],
  revenue_by_segment: [96400, 92100],
  open_orders_at_risk: [103.2, 120],
  stock_coverage: [14.6, 15.1],
  supplier_lead_time: [15.4, 14.8],
};
const NEXT_STEP: Record<string, string> = {
  net_revenue: "Ask Sales to review renewal delays in the West and compare findings with the regional revenue reading.",
  units_sold: "Check whether the drop is in one product group before changing the buying plan.",
  revenue_by_segment: "Compare the weakest segment with last quarter's pricing and promotions.",
  open_orders_at_risk: "Review the largest contributing group and monitor Open orders at risk again in 30 days.",
  stock_coverage: "Rebalance cover toward the fastest-moving lines before the next buying round.",
  supplier_lead_time: "Review open commitments with the affected supplier groups and update expected dates.",
};

function reading(base: Base, role: string, period: Period, year: number): Reading {
  const [v, p] = (period === "year" ? YEAR : CURRENT)[base.key];
  // Earlier years are a little smaller; the mock only needs to move when the filter does.
  const k = period === "year" ? Math.pow(0.96, 2025 - year) : 1;
  const value = +(v * k).toFixed(base.decimals);
  const prior = +(p * Math.pow(k, 1.1)).toFixed(base.decimals);
  const delta = +(value - prior).toFixed(base.decimals);
  const good = base.lowerIsBetter ? delta <= 0 : delta >= 0;
  return {
    key: base.key,
    name: base.name,
    role,
    unit: base.unit,
    decimals: base.decimals,
    value,
    prior,
    delta,
    lowerIsBetter: base.lowerIsBetter,
    trend: good ? "improving" : "attention",
    suggestion: good ? undefined : NEXT_STEP[base.key],
  };
}

const DEPARTMENTS: { id: string; name: string; roles: number; metrics: [Base, string][] }[] = [
  {
    id: "finance",
    name: "Finance",
    roles: 3,
    metrics: [[UNITS, "Finance lead"], [UNITS, "Finance analyst"], [NET, "Finance lead"], [NET, "Finance analyst"], [NET, "Controller"], [UNITS, "Controller"]],
  },
  {
    id: "sales",
    name: "Sales",
    roles: 2,
    metrics: [[UNITS, "Sales director"], [NET, "Sales director"], [SEG, "Sales director"], [NET, "Account manager"], [SEG, "Account manager"], [UNITS, "Account manager"]],
  },
  { id: "leadership", name: "Leadership", roles: 1, metrics: [[UNITS, "Chief executive officer"], [NET, "Chief executive officer"]] },
  {
    id: "purchasing",
    name: "Purchasing",
    roles: 3,
    metrics: ["Purchasing director", "Buyer", "Inventory planner"].flatMap((r) => [[ORDERS, r], [COVER, r], [LEAD, r]] as [Base, string][]),
  },
];

const IMPACT_PER_UNIT: Record<Unit, number> = { CAD: 1, USD: 1.35, orders: 280, days: 640, "": 5.2 };

/** Turns the readings that moved the wrong way into ranked recommendations (mock wording). */
function buildSuggestions(departments: Department[]): Suggestion[] {
  const out: Suggestion[] = [];
  for (const d of departments)
    for (const r of d.readings) {
      if (!r.suggestion) continue;
      out.push({
        id: `${d.id}-${r.key}-${r.role}`,
        title: r.lowerIsBetter ? `${r.name} moved away from baseline` : `${r.name} fell below the prior period`,
        department: d.name,
        role: r.role,
        metric: r.name,
        impact: Math.round(Math.abs(r.delta) * IMPACT_PER_UNIT[r.unit]),
        confidence: 80 + ((r.name.length * 7 + r.role.length * 3) % 15),
        headline: `${r.name} needs a look in ${d.name}`,
        what: `${r.name} is ${r.value} against ${r.prior} in the previous period.`,
        soWhat: "The move is outside the usual range for this reading, so it is worth checking before the next run.",
        nowWhat: r.suggestion,
        current: r,
      });
    }
  return out.sort((a, b) => b.impact - a.impact);
}

/** A local file can replace the built-in readings (gitignored, never committed): see
 * mocks.local/README.md. Same fields as the built-in data, with the delta and trend worked out here. */
type Input = { key: string; name: string; role: string; unit: Unit; decimals: number; value: number; prior: number; lowerIsBetter?: boolean; suggestion?: string };
type Section = { kpis: Input[]; departments: { id: string; name: string; roles: number; metrics: Input[] }[] };
type LocalFile = { company: string; activeRole: string; year: Section; current: Section };

function fromInput(i: Input): Reading {
  const delta = +(i.value - i.prior).toFixed(i.decimals);
  const good = i.lowerIsBetter ? delta <= 0 : delta >= 0;
  return { key: i.key, name: i.name, role: i.role, unit: i.unit, decimals: i.decimals, value: i.value, prior: i.prior, delta, lowerIsBetter: i.lowerIsBetter, trend: good ? "improving" : "attention", suggestion: good ? undefined : i.suggestion };
}

async function localOverride(): Promise<LocalFile | null> {
  if (process.env.NODE_ENV === "production") return null;
  try {
    const { readFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    return JSON.parse(await readFile(process.env.MOCK_EXECUTIVE_FILE ?? join(process.cwd(), "mocks.local", "executive.json"), "utf-8")) as LocalFile;
  } catch {
    return null;
  }
}

export async function getExecutiveOverview(opts: { period: Period; year: number }): Promise<ExecutiveOverview> {
  const { period, year } = opts;
  const local = await localOverride();
  if (local) {
    const sec = local[period];
    const departments = sec.departments.map((d) => ({ id: d.id, name: d.name, roles: d.roles, readings: d.metrics.map(fromInput) }));
    return {
      company: local.company,
      activeRole: local.activeRole,
      period,
      year,
      kpis: sec.kpis.map(fromInput),
      departments,
      suggestions: buildSuggestions(departments),
    };
  }
  const departments = DEPARTMENTS.map((d) => ({
    id: d.id,
    name: d.name,
    roles: d.roles,
    readings: d.metrics.map(([b, role]) => reading(b, role, period, year)),
  }));
  return {
    company: "Northstar Logistics",
    activeRole: "Chief Executive Officer",
    period,
    year,
    kpis: [reading(NET, "Chief executive officer", period, year), reading(UNITS, "Chief executive officer", period, year)],
    departments,
    suggestions: buildSuggestions(departments),
  };
}
