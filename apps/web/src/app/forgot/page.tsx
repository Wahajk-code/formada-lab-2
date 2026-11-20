import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { requestPasswordReset } from "@/app/actions";
import { AuthSubmit } from "@/components/auth/auth-form";
import { AuthShell } from "@/components/auth/auth-shell";

export default async function ForgotPage({ searchParams }: { searchParams: Promise<{ side?: string; sent?: string; dev?: string }> }) {
  const { side, sent, dev } = await searchParams;
  const internal = side === "internal";
  const [t, ta] = await Promise.all([getTranslations("reset"), getTranslations("auth")]);
  const back = internal ? "/login?side=internal" : "/login";
  return (
    <AuthShell internal={internal}>
      {sent ? (
        <>
          <h1>{t("sentTitle")}</h1>
          <p className="auth-lede">{t("sentHint")}</p>
          {dev && (
            <p className="auth-alert auth-alert-ok">
              {t("devLink")} <a href={dev} className="break-all font-semibold underline">{dev}</a>
            </p>
          )}
          <p className="auth-switch">
            <Link href={back}>{ta("backToSignIn")}</Link>
          </p>
        </>
      ) : (
        <>
          <h1>{t("title")}</h1>
          <p className="auth-lede">{t("hint")}</p>
          <form action={requestPasswordReset}>
            <input type="hidden" name="kind" value={internal ? "staff" : "person"} />
            <div className="auth-fields">
              <label className="auth-field">
                {ta("emailAddress")}
                <input name="email" type="email" autoComplete="username" required />
              </label>
              <AuthSubmit>{t("send")}</AuthSubmit>
            </div>
          </form>
          <p className="auth-switch">
            <Link href={back}>{ta("backToSignIn")}</Link>
          </p>
        </>
      )}
    </AuthShell>
  );
}
