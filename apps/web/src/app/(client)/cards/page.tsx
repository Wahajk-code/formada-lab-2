import { redirect } from "next/navigation";

/** Cards now live on the Dashboard (Formada.AI design, ADR 0030). Old links keep working. */
export default async function CardsPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const { role } = await searchParams;
  redirect(role ? `/dashboard?role=${role}` : "/dashboard");
}
