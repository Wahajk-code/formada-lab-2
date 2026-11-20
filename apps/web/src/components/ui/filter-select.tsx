"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

/** A labelled select (Formada.AI design `dw-select`) that keeps its choice in the URL, so the
 * server page re-renders for it and the link can be shared. Choosing the default drops the
 * parameter. */
export function FilterSelect({
  param,
  label,
  options,
  value,
  fallback = "",
}: {
  param: string;
  label: string;
  options: [string, string][];
  value: string;
  /** The value that means "no filter" (its parameter is left out of the URL). */
  fallback?: string;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  return (
    <label className="dw-select">
      <span>{label}</span>
      <select
        value={value}
        onChange={(e) => {
          const q = new URLSearchParams(params.toString());
          if (e.target.value === fallback) q.delete(param);
          else q.set(param, e.target.value);
          router.push(`${path}${q.size ? `?${q}` : ""}`);
        }}
      >
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
