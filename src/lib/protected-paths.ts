import { routing } from "@/i18n/routing";

const PROTECTED_SEGMENTS = ["app", "settings"];

/** Returns the locale of a path if it is in a protected area (/[locale]/app/**, /[locale]/settings/**), else null. */
export function protectedAreaLocale(pathname: string): string | null {
  const [, locale, area] = pathname.split("/");
  if (!(routing.locales as readonly string[]).includes(locale)) return null;
  return PROTECTED_SEGMENTS.includes(area) ? locale : null;
}
