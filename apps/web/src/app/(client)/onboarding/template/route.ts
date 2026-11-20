import { cookies } from "next/headers";

import { SESSION_COOKIE } from "@/lib/client-api";

const API = process.env.API_INTERNAL_URL ?? "http://localhost:8100";

/** The Excel org chart template, in the user's language. */
export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return new Response("Sign in first", { status: 401 });
  const res = await fetch(`${API}/api/onboarding/org-draft/template.xlsx`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok)
    return new Response("Template unavailable", { status: res.status });
  return new Response(await res.arrayBuffer(), {
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="org-chart-template.xlsx"',
    },
  });
}
