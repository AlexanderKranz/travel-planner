import { useFormatter, useLocale, useTranslations } from "next-intl";
import { AiBadge } from "@/components/plan/ai-badge";
import { monthName } from "@/components/trips/trip-title";
import { btnPrimary, btnSecondary, labelCls, linkCls, mutedCls, pillAccentCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { SuggestionCard } from "@/lib/domain/destination-search";
import { SOURCES } from "@/lib/facts/sources";
import { climateSummary, driveHours, flightHours } from "./helpers";

type SourceKey = "geonames" | "open_meteo" | "osm" | "openrouteservice";

/** "Source: X · checked 1 Nov 2026" for one verified fact. Every checked line carries one. */
function Source({ source, fetchedAt, stale }: { source: SourceKey; fetchedAt: string; stale: boolean }) {
  const t = useTranslations("discover.card");
  const ts = useTranslations("sources.items");
  const f = useFormatter();
  return (
    <span className={`block text-xs ${mutedCls}`}>
      {t("source")}:{" "}
      <a href={SOURCES[source].homepage ?? undefined} target="_blank" rel="noopener noreferrer" className={linkCls}>
        {ts(`${source}.label`)}
      </a>{" "}
      · {t("checkedOn", { date: f.dateTime(new Date(fetchedAt), { dateStyle: "medium" }) })}
      {stale && <span className="ml-2 rounded-full border border-warn-line bg-warn-bg px-2 py-0.5 font-medium text-warn-fg">{t("stale")}</span>}
    </span>
  );
}

function Block({ title, children, labelledBy }: { title: string; children: React.ReactNode; labelledBy: string }) {
  return (
    <section aria-labelledby={labelledBy} className="flex flex-col gap-2 border-t border-line pt-3">
      <h4 id={labelledBy} className={labelCls}>
        {title}
      </h4>
      {children}
    </section>
  );
}

/**
 * One suggestion in three separate blocks (spec section 6): what was checked (each line with source and date),
 * the flight estimate, and the AI's reason, labelled as a suggestion. Nothing here claims a direct flight.
 */
export function SuggestionCardView({
  card,
  searchId,
  tripId,
  driveFrom,
}: {
  card: SuggestionCard;
  searchId: string;
  /** Drive searches: the start place the drive was measured from. */
  driveFrom?: string | null;
  /** Id of a trip already made from this card, if any. */
  tripId: string | null;
}) {
  const t = useTranslations("discover.card");
  const tp = useTranslations("discover.poi");
  const ti = useTranslations("interests");
  const f = useFormatter();
  const locale = useLocale();
  const country = new Intl.DisplayNames([locale], { type: "region" }).of(card.countryCode) ?? card.countryCode;
  const place = [card.placeName, card.admin1, country].filter(Boolean).join(", ");
  const base = `card-${card.id}`;
  const climate = card.climate;
  const sum = climate?.status === "ok" ? climateSummary(climate.months) : null;
  const hasInterestKey = (k: string) => ti.has(k);

  return (
    <article className="flex h-full min-w-0 flex-col gap-3 rounded-[14px] border border-line bg-card p-4 sm:p-5" aria-labelledby={`${base}-title`}>
      <div className="flex flex-col gap-1">
        <h3 id={`${base}-title`} className="break-words font-serif text-2xl font-bold leading-tight">
          {card.name}
        </h3>
        {card.kind === "region" && <p className={`text-sm ${mutedCls}`}>{t("around", { place: card.placeName })}</p>}
        {tripId && <p className={pillAccentCls + " self-start"}>{t("hasTrip")}</p>}
      </div>

      <Block title={t("checked")} labelledBy={`${base}-checked`}>
        <ul className="flex flex-col gap-2 text-sm">
          <li>
            {t("place", { place })}
            <Source {...card.place} />
          </li>
          {card.drive && (
            <li>
              <span className="font-medium">
                {card.drive.min < 30
                  ? t("driveUnder30", { place: driveFrom ?? "", km: f.number(card.drive.km, { maximumFractionDigits: 0 }) })
                  : t("driveFacts", {
                      hours: f.number(driveHours(card.drive.min), { maximumFractionDigits: 1 }),
                      place: driveFrom ?? "",
                      km: f.number(card.drive.km, { maximumFractionDigits: 0 }),
                    })}
              </span>
              <Source source={card.drive.source} fetchedAt={card.drive.fetchedAt} stale={card.drive.stale} />
            </li>
          )}
          {climate?.status === "ok" && sum && (
            <li>
              <span className="font-medium">
                {t("climate", { months: climate.months.map((m) => monthName(m.month, locale, "long")).join(", ") })}
              </span>
              : {t("climateValue", { high: f.number(sum.high), low: f.number(sum.low), wet: f.number(sum.wet) })}
              <span className={`block text-xs ${mutedCls}`}>{t("climatePeriod", climate.period)}</span>
              <Source source={climate.source} fetchedAt={climate.fetchedAt} stale={climate.stale} />
            </li>
          )}
          {climate?.status === "not_checked" && <li>{t("climateNotChecked")}</li>}
          {card.pois.map((p) => {
            const label = hasInterestKey(p.interest) ? ti(p.interest) : p.interest;
            return p.status === "ok" ? (
              <li key={p.interest}>
                {t("poiCount", {
                  items: tp.has(p.interest) ? tp(p.interest, { count: p.count }) : `${p.count} ${label}`,
                  km: f.number(p.radiusKm, { maximumFractionDigits: 0 }),
                })}
                <Source {...p} />
              </li>
            ) : (
              <li key={p.interest}>{t("poiNotChecked", { interest: label })}</li>
            );
          })}
        </ul>
      </Block>

      {!card.drive && (
      <Block title={t("estimate")} labelledBy={`${base}-estimate`}>
        {card.flight ? (
          <p className="text-sm">
            <span className="font-medium">
              {t("flightEstimate", { hours: f.number(flightHours(card.flight.minutes), { maximumFractionDigits: 1 }) })}
            </span>{" "}
            {t("flightFrom", { origin: card.flight.origin })}
            <span className={`block text-xs ${mutedCls}`}>{t("flightNote")}</span>
          </p>
        ) : (
          <p className={`text-sm ${mutedCls}`}>{card.nearAirport ? t("closeToAirport") : t("noEstimate")}</p>
        )}
      </Block>
      )}

      {card.reason && (
        <Block title={t("suggestion")} labelledBy={`${base}-reason`}>
          <div className="flex flex-wrap items-center gap-2">
            <AiBadge />
            <span className={`text-xs ${mutedCls}`}>{t("suggestionHint")}</span>
          </div>
          <p className="text-sm italic">{card.reason}</p>
        </Block>
      )}

      <div className="mt-auto pt-1">
        {tripId ? (
          <Link href={`/app/trips/${tripId}`} className={`${btnSecondary} w-full`} aria-label={t("openTripLabel", { name: card.name })}>
            {t("openTrip")}
          </Link>
        ) : (
          <Link
            href={`/app/trips/new?search=${encodeURIComponent(searchId)}&card=${encodeURIComponent(card.id)}`}
            className={`${btnPrimary} w-full`}
            aria-label={t("selectLabel", { name: card.name })}
          >
            {t("select")}
          </Link>
        )}
      </div>
    </article>
  );
}
