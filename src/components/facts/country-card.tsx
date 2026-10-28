import { useTranslations } from "next-intl";
import type { CountryFacts } from "@/lib/domain";

function display(type: "region" | "currency" | "language", code: string, locale: string, fallback: string) {
  try {
    const name = new Intl.DisplayNames([locale], { type, fallback: "none" }).of(code);
    return name && name.toLowerCase() !== code.toLowerCase() ? name : fallback;
  } catch {
    return fallback;
  }
}

export function CountryCard({ data, locale }: { data: CountryFacts; locale: string }) {
  const t = useTranslations("facts.country");
  const list = new Intl.ListFormat(locale, { type: "conjunction" });
  const rows: [string, string][] = [
    [t("name"), display("region", data.code, locale, data.nameEn)],
  ];
  if (data.capital.length) rows.push([t("capital"), list.format(data.capital)]);
  if (data.currencies.length)
    rows.push([
      t("currency"),
      list.format(
        data.currencies.map((c) => {
          const name = display("currency", c.code, locale, c.code);
          return `${name} (${c.symbol && c.symbol !== c.code ? `${c.symbol}, ` : ""}${c.code})`;
        }),
      ),
    ]);
  if (data.languages.length)
    rows.push([
      t("languages"),
      list.format(data.languages.map((l) => display("language", l.code, locale, l.nameEn))),
    ]);
  if (data.callingCodes.length) rows.push([t("callingCode"), data.callingCodes.join(", ")]);
  rows.push([t("driving"), t(data.drivingSide === "left" ? "left" : "right")]);
  const tz = data.timezone;
  const tzParts = [tz.iana, tz.utcOffsets.length ? `UTC${tz.utcOffsets.join(" / UTC")}` : null].filter(Boolean);
  if (tzParts.length) rows.push([t("timezone"), tzParts.join(", ")]);
  else if (tz.countryZones.length) rows.push([t("timezone"), tz.countryZones.join(", ")]);
  return (
    <dl className="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="font-medium">{k}</dt>
          <dd className="min-w-0 break-words">{v}</dd>
        </div>
      ))}
      {tz.countryZones.length > 1 && tz.iana && (
        <div className="contents">
          <dt className="font-medium">{t("zones")}</dt>
          <dd className="min-w-0 break-words">{tz.countryZones.join(", ")}</dd>
        </div>
      )}
    </dl>
  );
}
