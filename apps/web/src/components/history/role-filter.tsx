"use client";

import { useRouter } from "next/navigation";

export function RoleFilter({
  roles,
  current,
  status,
  label,
  all,
}: {
  roles: { id: string; title: string }[];
  current: string;
  status: string;
  label: string;
  all: string;
}) {
  const router = useRouter();
  return (
    <label className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      {label}
      <select
        value={current}
        onChange={(e) => {
          const q = new URLSearchParams();
          if (e.target.value) q.set("role", e.target.value);
          if (status) q.set("status", status);
          router.push(`/history${q.size ? `?${q}` : ""}`);
        }}
        className="rounded-full border border-input bg-card px-3 py-1.5 text-sm text-foreground shadow-card outline-none focus:ring-2 focus:ring-ring/30"
      >
        <option value="">{all}</option>
        {roles.map((r) => (
          <option key={r.id} value={r.id}>
            {r.title}
          </option>
        ))}
      </select>
    </label>
  );
}
