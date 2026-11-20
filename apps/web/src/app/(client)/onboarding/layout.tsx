import { getTranslations } from "next-intl/server";

import { Icon } from "@/components/ui/icon";
import { api } from "@/lib/client-api";

/** Onboarding wrapper. Members (not owners or admins) only see that setup is under way. */
export default async function OnboardingLayout({ children }: { children: React.ReactNode }) {
  const [ob, t] = await Promise.all([api.onboarding(), getTranslations("onboarding")]);
  if (ob.member) {
    return (
      <div className="locked-card mx-auto mt-10 max-w-xl text-center">
        <span className="locked-icon">
          <Icon name="clock" size={24} />
        </span>
        <h3>{t("member.title")}</h3>
        <p>{t("member.body", { name: ob.workspace })}</p>
      </div>
    );
  }
  return <div className="onboarding">{children}</div>;
}
