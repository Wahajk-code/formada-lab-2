"use client";

import { ArrowRight, LoaderCircle } from "lucide-react";
import { useFormStatus } from "react-dom";

/** The primary button of an auth form: shows progress and blocks double submits. */
export function AuthSubmit({ children }: { children: React.ReactNode }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="auth-btn" disabled={pending} aria-busy={pending}>
      <span>{children}</span>
      {pending ? <LoaderCircle size={17} className="animate-spin" /> : <ArrowRight size={17} />}
    </button>
  );
}
