import { useTranslations } from "next-intl";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { InterestKey, Trip, TripPurpose } from "@/lib/domain";
import { INTEREST_KEYS } from "@/lib/domain";
import type { ResolvedAge, ResolvedEntry } from "@/lib/group";

const chip =
  "inline-flex items-center rounded-full border border-neutral-400 px-2 py-0.5 text-xs dark:border-neutral-500";

function AgeText({ age }: { age: ResolvedAge }) {
  const t = useTranslations("groups.preview");
  if (age.status === "known") return <>{age.approximate ? t("approx", { age: age.age }) : t("exact", { age: age.age })}</>;
  return <>{age.status === "aboutMyAge" ? t("aboutMe") : t("unknown")}</>;
}

export type ContextGroup = { id: string; name: string; ages: ResolvedEntry[] };

export function TripContext({
  trip,
  group,
  ageDate,
  purpose,
  profileAirports,
}: {
  trip: Trip;
  group: ContextGroup | null;
  ageDate: string;
  purpose: TripPurpose | null;
  profileAirports: string[];
}) {
  const t = useTranslations("trips.detail");
  const tp = useTranslations("groups.preview");
  const ti = useTranslations("interests");
  const interests = purpose?.guided.interests ?? [];
  const known = interests.filter((i): i is InterestKey => (INTEREST_KEYS as readonly string[]).includes(i));
  const custom = interests.filter((i) => !(INTEREST_KEYS as readonly string[]).includes(i));
  const airports = trip.originAirports.length > 0 ? trip.originAirports : profileAirports;

  return (
    <section aria-labelledby="context-title" className={`${cardCls} flex flex-col gap-4`}>
      <h2 id="context-title" className="text-lg font-semibold">
        {t("context")}
      </h2>
      <div>
        <h3 className="font-medium">{t("group")}</h3>
        {group ? (
          <>
            <p className="text-sm">
              <Link href={`/app/groups/${group.id}`} className={linkCls}>
                {group.name}
              </Link>
            </p>
            <p className={`text-sm ${mutedCls}`}>{tp("title", { date: ageDate })}</p>
            <ul className="mt-1 flex flex-col gap-1 text-sm">
              {group.ages.map((row, i) => {
                const who = row.kind === "composition" ? (row.label ?? tp("person")) : row.isSelf ? tp("me") : (row.name ?? row.label ?? tp("person"));
                return (
                  <li key={row.id ?? i}>
                    {row.kind === "composition" ? `${row.count} × ` : ""}
                    {who}: <span className="font-medium"><AgeText age={row.age} /></span>
                  </li>
                );
              })}
            </ul>
          </>
        ) : (
          <p className={`text-sm ${mutedCls}`}>{t("noGroup")}</p>
        )}
      </div>
      <div>
        <h3 className="font-medium">{t("purpose")}</h3>
        {purpose ? (
          <>
            <p className="text-sm">
              <Link href={`/app/purposes/${purpose.id}`} className={linkCls}>
                {purpose.name}
              </Link>
            </p>
            {(known.length > 0 || custom.length > 0) && (
              <ul className="mt-1 flex flex-wrap gap-1" aria-label={t("interests")}>
                {known.map((k) => (
                  <li key={k} className={chip}>{ti(k)}</li>
                ))}
                {custom.map((k) => (
                  <li key={k} className={chip}>{k}</li>
                ))}
              </ul>
            )}
          </>
        ) : (
          <p className={`text-sm ${mutedCls}`}>{t("noPurpose")}</p>
        )}
      </div>
      <div>
        <h3 className="font-medium">{t("flights")}</h3>
        {!trip.wantsFlights ? (
          <p className={`text-sm ${mutedCls}`}>{t("flightsOff")}</p>
        ) : airports.length > 0 ? (
          <p className="text-sm">
            {trip.originAirports.length > 0 ? t("originAirports") : t("homeAirports")}: {airports.join(", ")}
          </p>
        ) : (
          <p className={`text-sm ${mutedCls}`}>{t("noAirports")}</p>
        )}
      </div>
      {trip.notes && (
        <div>
          <h3 className="font-medium">{t("notes")}</h3>
          <p className="whitespace-pre-line break-words text-sm">{trip.notes}</p>
        </div>
      )}
    </section>
  );
}

