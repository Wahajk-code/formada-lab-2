import { getTranslations } from "next-intl/server";

import { acceptInvite } from "@/app/actions";
import { AuthSubmit } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";
import { api, ApiError } from "@/lib/client-api";

/** Public: the link from an invite email. Accepting sets a password, creates the account and
 *  signs in (ADR 0021, 0023). */
export default async function InvitePage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const [{ token }, { error }] = await Promise.all([params, searchParams]);
  const [t, tr, ta] = await Promise.all([getTranslations("inviteAccept"), getTranslations("reset"), getTranslations("auth")]);
  let info = null;
  try {
    info = await api.inviteInfo(token);
  } catch (e) {
    if (!(e instanceof ApiError)) throw e;
  }

  if (!info) {
    return (
      <AuthShell>
        <h1>{t("invalid")}</h1>
        <p className="auth-lede">{t("invalidHint")}</p>
      </AuthShell>
    );
  }
  const first = info.name.split(/\s+/)[0] || info.name;
  return (
    <AuthShell>
      <h1>{ta("welcomeName", { name: first })}</h1>
      <p className="auth-lede">{ta("joining", { workspace: info.workspace, role: t(`role.${info.app_role}`).toLowerCase() })}</p>
      {error && (
        <p className="auth-alert" role="alert">
          {error === "mismatch" ? tr("mismatch") : error}
        </p>
      )}
      <form action={acceptInvite.bind(null, token)}>
        <div className="auth-fields">
          <label className="auth-field">
            {ta("emailAddress")}
            <input value={info.email} readOnly tabIndex={-1} aria-readonly />
          </label>
          <label className="auth-field">
            {t("name")}
            <input name="name" defaultValue={info.name} required autoComplete="name" />
          </label>
          <label className="auth-field">
            {tr("newPassword")}
            <input name="password" type="password" autoComplete="new-password" required minLength={8} />
            <span className="auth-hint">{tr("rules")}</span>
          </label>
          <label className="auth-field">
            {tr("confirm")}
            <input name="confirm" type="password" autoComplete="new-password" required />
          </label>
          <AuthSubmit>{t("accept")}</AuthSubmit>
        </div>
      </form>
    </AuthShell>
  );
}
