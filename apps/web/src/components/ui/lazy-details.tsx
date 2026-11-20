"use client";

import { useState } from "react";

/** A `details` row that renders its body only once it has been opened (so a long list of rows
 * does not fetch or draw every body up front). The summary is given as markup. */
export function LazyDetails({
  className,
  defaultOpen = false,
  summary,
  children,
}: {
  className?: string;
  defaultOpen?: boolean;
  summary: React.ReactNode;
  children: React.ReactNode;
}) {
  const [seen, setSeen] = useState(defaultOpen);
  return (
    <details className={className} open={defaultOpen} onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && setSeen(true)}>
      <summary>{summary}</summary>
      {seen ? children : null}
    </details>
  );
}
