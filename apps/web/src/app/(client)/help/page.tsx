import { getLocale, getTranslations } from "next-intl/server";

import { HelpCenter } from "@/components/help/help-center";
import { ClientQuestions } from "@/components/onboarding/client-questions";
import { Icon } from "@/components/ui/icon";
import { articles } from "@/content/help";
import { api } from "@/lib/client-api";

/** Help center (Formada.AI design): a searchable list of topics and a way to ask the Formada team. */
export default async function HelpPage({ searchParams }: { searchParams: Promise<{ a?: string }> }) {
  const [{ a }, locale, t, me, ob] = await Promise.all([searchParams, getLocale(), getTranslations("help"), api.me(), api.onboarding()]);
  const list = articles(locale);
  const admin = me.app_role === "owner" || me.app_role === "admin";
  const threads = "threads" in ob ? ob.threads : [];
  return (
    <section className="utility-screen">
      <header className="utility-heading">
        <p className="eyebrow">{t("resources")}</p>
        <h1>{t("title")}</h1>
        <p className="screen-subtitle">{t("subtitle")}</p>
      </header>
      <HelpCenter articles={list} current={list.some((x) => x.slug === a) ? (a ?? null) : null} labels={{ search: t("searchLabel"), placeholder: t("search"), noMatch: t("noMatch") }} />
      <div className="utility-card help-contact">
        <span className="utility-symbol">
          <Icon name="message-circle" size={22} />
        </span>
        <div>
          <h2>{t("needHand")}</h2>
          <p>{t("needHandBody")}</p>
        </div>
      </div>
      <div className="max-w-[640px]">
        <ClientQuestions step="trial" threads={threads} can={admin && "threads" in ob} />
      </div>
    </section>
  );
}
