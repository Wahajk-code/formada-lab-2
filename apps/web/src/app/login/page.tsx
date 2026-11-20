import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { signIn, signInWithPassword } from "@/app/actions";
import { signInStaff, signInStaffWithPassword } from "@/app/console-actions";
import { AuthSubmit } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { api, type DevUser } from "@/lib/client-api";

type Search = Promise<{ side?: string; error?: string; email?: string; reset?: string }>;

function Chip({ label, action, email }: { label: string; action: (f: FormData) => Promise<void>; email: string }) {
  return (
    <form action={action}>
      <input type="hidden" name="email" value={email} />
      <button type="submit">{label}</button>
    </form>
  );
}

/** In-app sign-in (ADR 0023): email and password for client people and for the internal team.
 *  Local development also lists the seeded accounts as one-click shortcuts. */
export default async function LoginPage({ searchParams }: { searchParams: Search }) {
  const { side, error, email, reset } = await searchParams;
  const internal = side === "internal";
  const [t, ta, config] = await Promise.all([getTranslations("login"), getTranslations("auth"), api.authConfig()]);

  let chips: React.ReactNode = null;
  if (config.dev_login) {
    if (internal) {
      const staff = await api.devStaff();
      chips = staff.map((u) => <Chip key={u.email} label={`${u.name} · ${u.staff_role}`} action={signInStaff} email={u.email} />);
    } else {
      const users = await api.devUsers();
      const label = (u: DevUser) =>
        [u.app_role !== "member" ? t(`workspaceRole.${u.app_role}`) : null, u.roles.join(", ") || null].filter(Boolean).join(" · ") || t("noRole");
      chips = users.map((u) => <Chip key={u.email} label={`${u.name} · ${label(u)} · ${u.tenant}`} action={signIn} email={u.email} />);
    }
  }

  return (
    <AuthShell internal={internal}>
      <h1>{internal ? ta("internalWelcome") : ta("welcomeBack")}</h1>
      <p className="auth-lede">{internal ? ta("internalHint") : ta("welcomeBackHint")}</p>
      {reset && <p className="auth-alert auth-alert-ok">{t("resetDone")}</p>}
      {error && (
        <p className="auth-alert" role="alert">
          {t("error")}
        </p>
      )}
      <form action={internal ? signInStaffWithPassword : signInWithPassword}>
        <div className="auth-fields">
          <label className="auth-field">
            {ta("emailAddress")}
            <input name="email" type="email" autoComplete="username" required defaultValue={email} />
          </label>
          <label className="auth-field">
            <span className="auth-field-row">
              {t("password")}
              <Link href={internal ? "/forgot?side=internal" : "/forgot"}>{t("forgot")}</Link>
            </span>
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <AuthSubmit>{t("signIn")}</AuthSubmit>
        </div>
      </form>
      <p className="auth-switch">
        {internal ? (
          <Link href="/login">{ta("toClient")}</Link>
        ) : (
          <>
            {t("clientNote")} <Link href="/login?side=internal">{ta("toInternal")}</Link>
          </>
        )}
      </p>
      {chips && (
        <div className="auth-card">
          <strong>{ta("exploreTitle")}</strong>
          <p>{ta("exploreBody")}</p>
          <div className="auth-chips">{chips}</div>
        </div>
      )}
    </AuthShell>
  );
}
