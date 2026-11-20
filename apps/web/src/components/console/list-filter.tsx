"use client";

import { Search, X } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { cn } from "@/lib/utils";

export type FilterOption = { value: string; label: string; count?: number };
export type FilterDef = { param: string; label: string; options: FilterOption[] };

const SELECT =
  "rounded-full bg-card px-3 py-1.5 text-xs shadow-card outline-none ring-1 ring-border focus:ring-2 focus:ring-ring/40";

/** Search and filters kept in the URL (?q=, plus one param per filter), so the server page
 * filters the rows, links keep the view, and Back works. Empty values are dropped. */
export function ListFilter({
  placeholder = "Search",
  filters = [],
  total,
  shown,
}: {
  placeholder?: string;
  filters?: FilterDef[];
  total?: number;
  shown?: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [q, setQ] = useState(params.get("q") ?? "");
  const [pending, start] = useTransition();

  const push = (changes: Record<string, string>) => {
    const next = new URLSearchParams(params.toString());
    for (const [k, v] of Object.entries(changes)) {
      if (v) next.set(k, v);
      else next.delete(k);
    }
    const qs = next.toString();
    start(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }));
  };

  // Debounced search: the page refetches once typing pauses.
  useEffect(() => {
    if ((params.get("q") ?? "") === q) return;
    const id = setTimeout(() => push({ q }), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- push reads the latest params
  }, [q]);

  const active = filters.some((f) => params.get(f.param)) || !!params.get("q");

  return (
    <div className={cn("flex flex-wrap items-center gap-2 transition-opacity", pending && "opacity-70")}>
      <label className="flex min-w-56 flex-1 items-center gap-2 rounded-full bg-card px-3 py-1.5 shadow-card ring-1 ring-border focus-within:ring-2 focus-within:ring-ring/40 sm:max-w-sm">
        <Search className="size-3.5 text-muted-foreground" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full bg-transparent text-xs outline-none"
        />
      </label>
      {filters.map((f) => (
        <select
          key={f.param}
          aria-label={f.label}
          value={params.get(f.param) ?? ""}
          onChange={(e) => push({ [f.param]: e.target.value })}
          className={SELECT}
        >
          <option value="">{f.label}: all</option>
          {f.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
              {o.count !== undefined ? ` (${o.count})` : ""}
            </option>
          ))}
        </select>
      ))}
      {active && (
        <button
          type="button"
          onClick={() => {
            setQ("");
            push(Object.fromEntries([["q", ""], ...filters.map((f) => [f.param, ""])]));
          }}
          className="inline-flex items-center gap-1 rounded-full px-2.5 py-1.5 text-xs text-muted-foreground hover:bg-surface hover:text-foreground"
        >
          <X className="size-3" /> Clear
        </button>
      )}
      {total !== undefined && (
        <span className="ml-auto text-xs text-muted-foreground tabular-nums">
          {shown ?? total} of {total}
        </span>
      )}
    </div>
  );
}
