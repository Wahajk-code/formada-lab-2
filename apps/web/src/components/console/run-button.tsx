"use client";

import { LoaderCircle, Play } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { runWorkspaceNow } from "@/app/console-actions";
import { Button } from "@/components/ui/button";

export function RunButton({ workspaceId, can = true }: { workspaceId: string; can?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        size="sm"
        disabled={!can || pending}
        title={can ? undefined : "Admins only"}
        onClick={() =>
          start(async () => {
            const res = await runWorkspaceNow(workspaceId);
            setMsg(res.ok ? "Started: WF1 is running for this workspace." : res.error);
            if (res.ok) setTimeout(() => router.refresh(), 5000);
          })
        }
      >
        {pending ? <LoaderCircle className="animate-spin" /> : <Play />} Run weekly now
      </Button>
      {msg && <span className="text-xs text-muted-foreground">{msg}</span>}
    </span>
  );
}
