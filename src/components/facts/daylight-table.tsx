import { useFormatter, useTranslations } from "next-intl";
import type { DaylightFacts } from "@/lib/domain";
import { mutedCls } from "@/components/ui/styles";

const th = "px-2 py-2 text-left font-medium whitespace-nowrap";
const td = "px-2 py-2 whitespace-nowrap tabular-nums";

export function DaylightTable({ data }: { data: DaylightFacts }) {
  const t = useTranslations("facts.daylight");
  const f = useFormatter();
  const time = (iso: string | null) =>
    iso
      ? f.dateTime(new Date(iso), { hour: "2-digit", minute: "2-digit", timeZone: data.timezone })
      : "–";
  const date = (d: string) => {
    const [y, m, day] = d.split("-").map(Number);
    return f.dateTime(new Date(Date.UTC(y, m - 1, day)), {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  };
  const hours = (min: number) => t("duration", { h: Math.floor(min / 60), m: min % 60 });
  const caption = t(data.basis === "trip_dates" ? "captionTrip" : "captionMid");
  return (
    <div className="flex flex-col gap-3">
      <p className={`text-sm ${mutedCls}`}>{t("intro", { timezone: data.timezone })}</p>
      <div
        role="region"
        aria-label={caption}
        tabIndex={0}
        className="overflow-x-auto rounded-md focus-visible:outline-2 focus-visible:outline-focus"
      >
        <table className="w-full min-w-[24rem] text-sm">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className={th}>{t("date")}</th>
              <th scope="col" className={th}>{t("sunrise")}</th>
              <th scope="col" className={th}>{t("sunset")}</th>
              <th scope="col" className={th}>{t("dusk")}</th>
              <th scope="col" className={th}>{t("hours")}</th>
            </tr>
          </thead>
          <tbody>
            {data.days.map((d) => (
              <tr key={d.date} className="border-b border-line last:border-0">
                <th scope="row" className={th}>{date(d.date)}</th>
                {d.polar ? (
                  <td colSpan={3} className={td}>{t(d.polar === "day" ? "polarDay" : "polarNight")}</td>
                ) : (
                  <>
                    <td className={td}>{time(d.sunrise)}</td>
                    <td className={td}>{time(d.sunset)}</td>
                    <td className={td}>{time(d.dusk)}</td>
                  </>
                )}
                <td className={td}>{hours(d.daylightMinutes)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
