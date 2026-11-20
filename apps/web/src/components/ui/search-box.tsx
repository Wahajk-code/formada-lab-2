"use client";

import { Search } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef, useState } from "react";

/** A search field that keeps its text in the URL (after a short pause), so the server page filters
 * and the result can be shared. */
export function SearchBox({ param = "q", label, placeholder }: { param?: string; label: string; placeholder?: string }) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const [text, setText] = useState(params.get(param) ?? "");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const push = (v: string) => {
    const q = new URLSearchParams(params.toString());
    if (v.trim()) q.set(param, v.trim());
    else q.delete(param);
    router.replace(`${path}${q.size ? `?${q}` : ""}`, { scroll: false });
  };
  return (
    <label className="dw-search">
      <span>{label}</span>
      <span className="dw-search-field">
        <Search size={18} aria-hidden="true" />
        <input
          type="search"
          value={text}
          placeholder={placeholder}
          onChange={(e) => {
            setText(e.target.value);
            clearTimeout(timer.current);
            timer.current = setTimeout(() => push(e.target.value), 280);
          }}
        />
      </span>
    </label>
  );
}
