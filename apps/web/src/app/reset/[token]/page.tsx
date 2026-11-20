import { getTranslations } from "next-intl/server";

import { resetPassword } from "@/app/actions";
import { AuthSubmit } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default async function ResetPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<{ side?: string; error?: string }>;
}) {
  const [{ token }, { side, error }, t] = await Promise.all([params, searchParams, getTranslations("reset")]);
  const internal = side === "internal";
  return (
    <AuthShell internal={internal}>
      <h1>{t("newTitle")}</h1>
      <p className="auth-lede">{t("rules")}</p>
      {error && (
        <p className="auth-alert" role="alert">
          {error === "mismatch" ? t("mismatch") : error.includes("not found") ? t("expired") : error}
        </p>
      )}
      <form action={resetPassword.bind(null, token)}>
        <div className="auth-fields">
          <label className="auth-field">
            {t("newPassword")}
            <input name="password" type="password" autoComplete="new-password" required minLength={8} />
            <span className="auth-hint">{t("rules")}</span>
          </label>
          <label className="auth-field">
            {t("confirm")}
            <input name="confirm" type="password" autoComplete="new-password" required />
          </label>
          <AuthSubmit>{t("save")}</AuthSubmit>
        </div>
      </form>
    </AuthShell>
  );
}
