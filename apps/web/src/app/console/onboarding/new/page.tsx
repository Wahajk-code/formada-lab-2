import { ArrowLeft } from "lucide-react";
import Link from "next/link";

import { NewWorkspaceForm } from "@/components/console/onboarding/new-workspace-form";

export default function NewWorkspacePage() {
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <Link
          href="/console"
          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-3.5" /> All workspaces
        </Link>
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">
          Onboarding
        </p>
        <h1 className="text-2xl font-semibold tracking-tight">New workspace</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          Creates the client&apos;s workspace and its owner. Next you connect
          the warehouse, and the onboarding agents propose the data guide, the
          mapping, the org web, the metrics and the business rules for you to
          check and approve.
        </p>
      </header>
      <NewWorkspaceForm />
    </div>
  );
}
