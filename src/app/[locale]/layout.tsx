import type { Metadata } from "next";
import localFont from "next/font/local";
import { notFound } from "next/navigation";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import "../globals.css";

// Self-hosted latin subsets (variable woff2 from Google Fonts; OFL licences sit next to the files).
// next/font/google fetched from Google at build time and failed intermittently.
const inter = localFont({
  src: "../../assets/web-fonts/Inter-latin-variable.woff2",
  variable: "--font-inter",
  weight: "100 900",
  style: "normal",
  display: "swap",
});

const fraunces = localFont({
  src: "../../assets/web-fonts/Fraunces-latin-variable.woff2",
  variable: "--font-fraunces",
  weight: "500 700",
  style: "normal",
  display: "swap",
});

// Latin Extended (Ł, ź, ő ...) for destination names, as a second family: the browser downloads it only when a page
// uses such a character, so normal pages stay as light as before.
const interExt = localFont({
  src: "../../assets/web-fonts/Inter-latin-ext-variable.woff2",
  variable: "--font-inter-ext",
  weight: "100 900",
  style: "normal",
  display: "swap",
  preload: false,
});

const frauncesExt = localFont({
  src: "../../assets/web-fonts/Fraunces-latin-ext-variable.woff2",
  variable: "--font-fraunces-ext",
  weight: "500 700",
  style: "normal",
  display: "swap",
  preload: false,
});

type Props = {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
};

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "meta" });
  return { title: t("title"), description: t("description") };
}

export default async function LocaleLayout({ children, params }: Props) {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);

  return (
    <html lang={locale}>
      <body className={`${inter.variable} ${fraunces.variable} ${interExt.variable} ${frauncesExt.variable} antialiased`}>
        <NextIntlClientProvider>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
