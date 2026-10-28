import type { Money } from "@/lib/domain/items";

export function makeFormat(locale: string) {
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
  const month = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
  const iso = (s: string) => new Date(`${s.slice(0, 10)}T00:00:00Z`);
  const cents = (c: number, currency: string) =>
    new Intl.NumberFormat(locale, { style: "currency", currency }).format(c / 100);
  return {
    date: (s: string) => date.format(iso(s)),
    dayDate: (s: string) => long.format(iso(s)),
    months: (ms: number[]) => ms.map((m) => month.format(new Date(Date.UTC(2000, m - 1, 1)))).join(", "),
    cents,
    money: (m: Money, currency: string) =>
      m.minCents === m.maxCents ? cents(m.minCents, currency) : `${cents(m.minCents, currency)} – ${cents(m.maxCents, currency)}`,
    duration: (min: number) => `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")} h`,
  };
}
export type Fmt = ReturnType<typeof makeFormat>;
