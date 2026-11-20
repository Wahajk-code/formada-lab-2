/** Case-insensitive match of a search term against any of the given fields. */
export function matches(q: string | undefined, ...fields: (string | null | undefined)[]) {
  if (!q) return true;
  const needle = q.toLowerCase();
  return fields.some((f) => (f ?? "").toLowerCase().includes(needle));
}

/** Newest first by the first date present (ISO strings sort as dates). */
export function newestFirst<T>(rows: T[], ...dates: ((r: T) => string | null | undefined)[]) {
  const key = (r: T) => dates.map((d) => d(r)).find(Boolean) ?? "";
  return [...rows].sort((a, b) => key(b).localeCompare(key(a)));
}
