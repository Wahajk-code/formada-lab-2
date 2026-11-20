"use client";

import { LoaderCircle, RefreshCw } from "lucide-react";
import { useRouter } from "next/navigation";
import { useTransition } from "react";

/** Re-reads the page's data. The icon spins while the server answers. */
export function RefreshButton({ label }: { label: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <button type="button" className="ex-chip ex-chip-btn" disabled={pending} onClick={() => start(() => router.refresh())}>
      {pending ? <LoaderCircle size={17} className="animate-spin" /> : <RefreshCw size={17} />}
      <span>{label}</span>
    </button>
  );
}
