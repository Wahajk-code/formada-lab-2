import { notFound } from "next/navigation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A workspace id that is not a UUID can never exist, so answer 404 instead of letting the API reject it. */
export default async function WorkspaceLayout({ children, params }: { children: React.ReactNode; params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return children;
}
