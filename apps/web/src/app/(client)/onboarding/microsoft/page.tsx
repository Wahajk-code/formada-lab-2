import { MicrosoftImport } from "@/components/onboarding/microsoft-import";

/** Microsoft sends the admin back here after consent (?tenant=...&state=...). */
export default async function MicrosoftCallback({
  searchParams,
}: {
  searchParams: Promise<{
    tenant?: string;
    state?: string;
    error_description?: string;
  }>;
}) {
  const q = await searchParams;
  return (
    <MicrosoftImport
      tenant={q.tenant ?? ""}
      state={q.state ?? ""}
      error={q.error_description ?? null}
    />
  );
}
