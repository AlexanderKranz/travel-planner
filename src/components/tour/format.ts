import { durationParts } from "@/lib/tour/ui";

type T = (key: string, values?: Record<string, string | number>) => string;

/** "45 Min." / "2 Std. 5 Min." from the `tours` messages. */
export function formatDuration(t: T, min: number): string {
  const p = durationParts(min);
  return t(p.key, p.values);
}

/** Tour title: the user's own, else "Wien · 5 Orte" (`tours.defaultTitle`). */
export function tourTitle(t: T, title: string | null, city: string | null, count: number): string {
  return title?.trim() || t("defaultTitle", { hasCity: city ? "yes" : "no", city: city ?? "", count });
}
