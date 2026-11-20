import type { Metadata } from "next";
import localFont from "next/font/local";
import { NextIntlClientProvider } from "next-intl";
import { getLocale } from "next-intl/server";
import "./globals.css";

// Formada.AI type (licences next to the files): Urbanist for the interface, IBM Plex Mono for
// eyebrows, tags and figures.
const urbanist = localFont({
  src: "../fonts/urbanist.ttf",
  variable: "--font-urbanist",
  weight: "100 900",
  display: "swap",
});

const plexMono = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono.ttf", weight: "400" },
    { path: "../fonts/ibm-plex-mono-medium.ttf", weight: "500" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Formada.AI",
  description: "Ranked insight cards for every role in the org web.",
  icons: { icon: "/brand/formada-mark.svg" },
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  const locale = await getLocale();
  return (
    <html lang={locale} className={`${urbanist.variable} ${plexMono.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col">
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}

export const maxDuration = 60;
