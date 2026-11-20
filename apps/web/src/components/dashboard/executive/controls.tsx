"use client";

import { BarChart3, ChevronDown, Lightbulb } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

export type ControlLabels = {
  tabCompany: string;
  tabSuggestions: string;
  department: string;
  allDepartments: string;
  period: string;
  byYear: string;
  current: string;
  year: string;
  refresh: string;
  tabs: string;
};

/** Tabs and filters. They live in the URL, so a view can be shared and the server re-reads the data
 * (mock today, live later) on every change. */
export function ExecutiveControls({
  labels,
  departments,
  suggestionCount,
  years,
}: {
  labels: ControlLabels;
  departments: { id: string; name: string }[];
  suggestionCount: number;
  years: number[];
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [pending, start] = useTransition();
  const get = (k: string, d: string) => params.get(k) ?? d;
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(patch)) next.set(k, v);
    start(() => router.replace(`${path}?${next.toString()}`, { scroll: false }));
  };
  const tab = get("tab", "company");
  const period = get("period", "year");
  return (
    <div className="ex-controls" data-pending={pending}>
      <div className="ex-tabs" role="tablist" aria-label={labels.tabs}>
        <button type="button" role="tab" aria-selected={tab === "company"} onClick={() => set({ tab: "company" })}>
          <BarChart3 size={17} aria-hidden="true" /> {labels.tabCompany}
        </button>
        <button type="button" role="tab" aria-selected={tab === "suggestions"} onClick={() => set({ tab: "suggestions" })}>
          <Lightbulb size={17} aria-hidden="true" /> {labels.tabSuggestions}
          <span className="ex-count">{suggestionCount}</span>
        </button>
      </div>
      <div className="ex-filters">
        <label>
          {labels.department}
          <span className="ex-select">
            <select value={get("dept", "all")} onChange={(e) => set({ dept: e.target.value })}>
              <option value="all">{labels.allDepartments}</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </label>
        <label>
          {labels.period}
          <span className="ex-select">
            <select value={period} onChange={(e) => set({ period: e.target.value })}>
              <option value="year">{labels.byYear}</option>
              <option value="current">{labels.current}</option>
            </select>
            <ChevronDown size={16} aria-hidden="true" />
          </span>
        </label>
        {period === "year" && (
          <label>
            {labels.year}
            <span className="ex-select ex-select-sm">
              <select value={get("year", String(years[0]))} onChange={(e) => set({ year: e.target.value })}>
                {years.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
              <ChevronDown size={16} aria-hidden="true" />
            </span>
          </label>
        )}
      </div>
    </div>
  );
}
