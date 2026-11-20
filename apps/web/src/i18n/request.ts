import { cookies } from "next/headers";
import { getRequestConfig } from "next-intl/server";

export const locales = ["en", "fr"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";
export const LOCALE_COOKIE = "NEXT_LOCALE";

function isLocale(value: string | undefined): value is Locale {
  return locales.includes(value as Locale);
}

export default getRequestConfig(async () => {
  const fromCookie = (await cookies()).get(LOCALE_COOKIE)?.value;
  const locale: Locale = isLocale(fromCookie) ? fromCookie : defaultLocale;
  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  };
});
