import { LogOut } from "lucide-react";

import { changeStaffPassword, staffSignOutEverywhere } from "@/app/console-actions";
import { PasswordForm } from "@/components/account/password-form";
import { consoleApi } from "@/lib/console-api";

export default async function ConsoleAccountPage() {
  const me = await consoleApi.me();
  return (
    <div className="space-y-6">
      <header className="animate-rise space-y-1">
        <p className="text-xs font-medium uppercase tracking-[0.14em] text-brand">Internal console</p>
        <h1 className="text-2xl font-semibold tracking-tight">Your account</h1>
        <p className="text-sm text-muted-foreground">
          {me.name} · {me.email} · <span className="capitalize">{me.staff_role}</span>
        </p>
      </header>
      <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-card">
        <h2 className="text-sm font-semibold">What you can do</h2>
        <div className="flex flex-wrap gap-1.5">
          {me.permissions.map((p) => (
            <span key={p} className="rounded-full bg-card px-2.5 py-1 font-mono text-[11px] shadow-card">{p}</span>
          ))}
        </div>
      </section>
      <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-card">
        <h2 className="text-sm font-semibold">Password</h2>
        <PasswordForm
          onSave={changeStaffPassword}
          labels={{
            current: "Current password",
            next: "New password",
            confirm: "Confirm the new password",
            save: "Change password",
            saved: "Password changed. Your other sessions were signed out.",
            mismatch: "The two passwords differ.",
            rules: "At least 10 characters, not your email.",
          }}
        />
      </section>
      <section className="space-y-3 rounded-2xl bg-surface p-5 shadow-card">
        <h2 className="text-sm font-semibold">Sessions</h2>
        <p className="text-sm text-muted-foreground">Signs you out on every device, including this one.</p>
        <form action={staffSignOutEverywhere}>
          <button type="submit" className="inline-flex items-center gap-1.5 rounded-full bg-card px-3.5 py-2 text-sm shadow-card hover:-translate-y-px">
            <LogOut className="size-4" aria-hidden /> Sign out everywhere
          </button>
        </form>
      </section>
    </div>
  );
}
