"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";

import type { Article } from "@/content/help";
import { cn } from "@/lib/utils";

function text(a: Article) {
  return [
    a.title,
    a.summary,
    ...a.sections.flatMap((s) => [
      s.h,
      ...s.blocks.flatMap((b) => ("p" in b ? [b.p] : "dl" in b ? b.dl.flat() : b.steps)),
    ]),
  ]
    .join(" ")
    .toLowerCase();
}

/** Article list with a client-side search over titles and bodies. */
export function HelpSearch({
  articles,
  current,
  placeholder,
  noMatch,
}: {
  articles: Article[];
  current: string;
  placeholder: string;
  noMatch: string;
}) {
  const [q, setQ] = useState("");
  const index = useMemo(() => articles.map((a) => ({ a, text: text(a) })), [articles]);
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  const shown = index.filter(({ text }) => terms.every((t) => text.includes(t))).map(({ a }) => a);
  const groups = [...new Set(shown.map((a) => a.group))];

  return (
    <div className="space-y-4">
      <label className="relative block">
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
        <input
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={placeholder}
          aria-label={placeholder}
          className="w-full rounded-xl border border-input bg-card py-2.5 pl-9 pr-3 text-sm shadow-card outline-none focus:ring-2 focus:ring-ring/30"
        />
      </label>
      {shown.length === 0 && <p className="px-1 text-sm text-muted-foreground">{noMatch}</p>}
      <nav className="space-y-4">
        {groups.map((g) => (
          <div key={g} className="space-y-1">
            <p className="px-3 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">{g}</p>
            {shown
              .filter((a) => a.group === g)
              .map((a) => (
                <Link
                  key={a.slug}
                  href={`/help?a=${a.slug}`}
                  scroll={false}
                  aria-current={a.slug === current ? "page" : undefined}
                  className={cn(
                    "block rounded-lg px-3 py-2 transition-all duration-200",
                    a.slug === current ? "bg-card shadow-card" : "hover:bg-card/60",
                  )}
                >
                  <span className="block text-sm font-medium">{a.title}</span>
                  <span className="block truncate text-xs text-muted-foreground">{a.summary}</span>
                </Link>
              ))}
          </div>
        ))}
      </nav>
    </div>
  );
}
