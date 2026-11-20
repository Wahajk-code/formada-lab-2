"use client";

import { CheckCheck } from "lucide-react";
import { useTransition } from "react";

import { markNotificationsRead } from "@/app/onboarding-actions";
import { Button } from "@/components/ui/button";

export function MarkAllRead({ label }: { label: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() => start(async () => void (await markNotificationsRead()))}
    >
      <CheckCheck /> {label}
    </Button>
  );
}
