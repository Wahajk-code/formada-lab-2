import Link from "next/link";
import { getTranslations } from "next-intl/server";

import { Logo } from "@/components/logo";

/** The animated org-web drawing in the brand panel: one role above two, joined by flowing lines. */
function OrgIllustration() {
  return (
    <div className="auth-illustration" aria-hidden="true">
      <svg viewBox="0 0 510 326" fill="none">
        <g className="auth-grid">
          {[26, 120, 186, 253, 320, 386, 453].map((x) => (
            <path key={`v${x}`} d={`M${x} 46V296`} />
          ))}
          {[72, 139, 205, 272].map((y) => (
            <path key={`h${y}`} d={`M28 ${y}H482`} />
          ))}
        </g>
        <path className="auth-wire" d="M255 105V138H130V170M255 105V138H380V170" />
        <path className="auth-wire" d="M130 214V228M80 228H180M380 214V228M330 228H430" />
        <g className="auth-node auth-node-root">
          <rect x="183" y="49" width="144" height="56" rx="16" fill="#eeeafe" />
          <circle cx="212" cy="77" r="9" fill="#6f4ec9" />
          <path d="M232 71H284M232 82H262" stroke="#6f4ec9" strokeWidth="3" strokeLinecap="round" />
        </g>
        <g className="auth-node auth-node-a">
          <rect x="68" y="170" width="126" height="48" rx="14" fill="#2c2d31" stroke="#3a3b40" />
          <circle cx="92" cy="194" r="7" fill="#48b8a6" />
          <path d="M108 189H156M108 199H138" stroke="#8d8f95" strokeWidth="3" strokeLinecap="round" />
        </g>
        <g className="auth-node auth-node-b">
          <rect x="318" y="170" width="126" height="48" rx="14" fill="#2c2d31" stroke="#3a3b40" />
          <circle cx="342" cy="194" r="7" fill="#48b8a6" />
          <path d="M358 189H406M358 199H388" stroke="#8d8f95" strokeWidth="3" strokeLinecap="round" />
        </g>
        {[80, 180, 330, 430].map((x) => (
          <circle key={x} className="auth-leaf" cx={x} cy="230" r="5" fill="#48b8a6" />
        ))}
      </svg>
    </div>
  );
}

/** The split layout shared by every auth screen (Formada.AI design): brand panel left, form right. */
export async function AuthShell({
  children,
  internal = false,
  wide = false,
}: {
  children: React.ReactNode;
  internal?: boolean;
  wide?: boolean;
}) {
  const t = await getTranslations("auth");
  return (
    <main className={internal ? "auth console" : "auth"}>
      <aside className="auth-panel">
        <div className="auth-brand">
          <Link href="/" aria-label="Formada.AI">
            <Logo reversed />
          </Link>
          {internal && <span className="auth-pill">{t("internalPill")}</span>}
        </div>
        <div className="auth-pitch">
          <p className="auth-eyebrow">{internal ? t("internalEyebrow") : t("eyebrow")}</p>
          <h2>{t("pitchTitle")}</h2>
          <p>{t("pitchBody")}</p>
        </div>
        <OrgIllustration />
      </aside>
      <section className="auth-main">
        <div className={wide ? "auth-form auth-form-wide" : "auth-form"}>{children}</div>
      </section>
    </main>
  );
}
