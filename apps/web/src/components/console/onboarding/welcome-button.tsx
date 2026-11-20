"use client";

import { LoaderCircle, Mail } from "lucide-react";
import { useState, useTransition } from "react";

import { resendWelcome } from "@/app/console-actions";

/** Emails the workspace owner a new set-your-password link. */
export function WelcomeButton({ workspaceId, owner, can }: { workspaceId: string; owner: string; can: boolean }) {
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      Owner {owner}
      <button
        type="button"
        disabled={!can || pending}
        onClick={() =>
          start(async () => {
            const res = await resendWelcome(workspaceId);
            setMsg(res.ok ? `Welcome email sent to ${res.data?.to}` : res.error);
          })
        }
        className="inline-flex items-center gap-1 rounded-full bg-card px-2.5 py-1 shadow-card transition-transform hover:-translate-y-px disabled:opacity-50"
      >
        {pending ? <LoaderCircle className="size-3 animate-spin" /> : <Mail className="size-3" />} Resend welcome email
      </button>
      {msg && <span>{msg}</span>}
    </span>
  );
}
