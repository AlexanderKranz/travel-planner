import { useTranslations } from "next-intl";
import { cardCls, linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import type { InterestKey, Trip, TripPurpose } from "@/lib/domain";
import { INTEREST_KEYS } from "@/lib/domain";
import { useGroupSummaryText } from "@/components/groups/summary-text";
import type { ResolvedAge } from "@/lib/group";
import type { ResolvedGroup } from "@/lib/group-text";

const chip =
  "inline-flex items-center rounded-full border border-heading/50 px-2.5 py-0.5 text-xs font-medium text-heading";

function AgeText({ age }: { age: ResolvedAge }) {
  const t = useTranslations("groups.preview");
  if (age.status === "known") return <>{age.approximate ? t("approx", { age: age.age }) : t("exact", { age: age.age })}</>;
  return <>{age.status === "aboutMyAge" ? t("aboutMe") : t("unknown")}</>;
}

/** `id`/`name` only for a saved group; a one-off group of the trip has neither. `text` is its free text. */
export type ContextGroup = { id?: string; name?: string; text?: string; resolved: ResolvedGroup };

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
  const summary = useGroupSummaryText();
  const ti = useTranslations("interests");
  const interests = purpose?.guided.interests ?? [];
  const known = interests.filter((i): i is InterestKey => (INTEREST_KEYS as readonly string[]).includes(i));
  const custom = interests.filter((i) => !(INTEREST_KEYS as readonly string[]).includes(i));
  const airports = trip.originAirports.length > 0 ? trip.originAirports : profileAirports;

  return (
    // Compact strip (spec timed-items [D16]): 3 columns from lg (group, purpose, flights), stacked on phones.
    <section aria-labelledby="context-title" className={`${cardCls} grid gap-4 sm:grid-cols-2 lg:grid-cols-3 lg:gap-x-6`}>
      <h2 id="context-title" className="text-lg font-semibold sm:col-span-2 lg:col-span-3">
        {t("context")}
      </h2>
      <div className="min-w-0">
        <h3 className="font-medium">{t("group")}</h3>
        {group ? (
          <>
            <p className="text-sm">
              {group.id ? (
                <Link href={`/app/groups/${group.id}`} className={linkCls}>
                  {group.name}
                </Link>
              ) : (
                <Link href={`/app/trips/${trip.id}/edit`} className={linkCls}>
                  {t("groupOneOff")}
                </Link>
              )}
              {summary(group.resolved) ? ` · ${summary(group.resolved)}` : ""}
            </p>
            {group.resolved.source === "text" ? (
              group.text && <p className={`line-clamp-3 break-words text-sm ${mutedCls}`}>{group.text}</p>
            ) : (
              <>
                <p className={`text-sm ${mutedCls}`}>{tp("title", { date: ageDate })}</p>
                <ul className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-sm">
                  {group.resolved.rows.map((row, i) => {
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
            )}
          </>
        ) : (
          <p className={`text-sm ${mutedCls}`}>{t("noGroup")}</p>
        )}
      </div>
      <div className="min-w-0">
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
      <div className="min-w-0">
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
        <div className="min-w-0 sm:col-span-2 lg:col-span-3">
          <h3 className="font-medium">{t("notes")}</h3>
          <p className="whitespace-pre-line break-words text-sm">{trip.notes}</p>
        </div>
      )}
    </section>
  );
}

