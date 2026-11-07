import { useTranslations } from "next-intl";
import { Link } from "@/i18n/navigation";
import { TripCard } from "@/components/trips/trip-card";
import { cardCls, focusCls, mutedCls } from "@/components/ui/styles";
import type { IncomingShare } from "@/lib/domain/sharing";
import { ShareBadge } from "./share-badge";

/** "Shared with me" trips: the same cards as own trips, with the owner/level badge. Hidden when empty. */
export function SharedTrips({ shares, headingLevel = 2 }: { shares: IncomingShare[]; headingLevel?: 2 | 3 }) {
  const t = useTranslations("sharing");
  const trips = shares.flatMap((s) => (s.resource === "trip" && s.trip ? [s.trip] : []));
  if (trips.length === 0) return null;
  const H = headingLevel === 2 ? "h2" : "h3";
  return (
    <section aria-labelledby="shared-trips-title" className="flex flex-col gap-2" data-testid="shared-trips">
      <H id="shared-trips-title" className="mt-2 font-serif text-xl font-bold text-heading">
        {t("sharedWithMe")}
      </H>
      <ul className="flex flex-col gap-2">
        {trips.map((trip) => (
          <li key={trip.id}>
            <TripCard trip={trip} />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Shared with me" purposes as cards with the owner/level badge. Hidden when empty. */
export function SharedPurposes({ shares }: { shares: IncomingShare[] }) {
  const t = useTranslations("sharing");
  const items = shares.flatMap((s) => (s.resource === "purpose" && s.purpose ? [{ share: s, purpose: s.purpose }] : []));
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="shared-purposes-title" className="flex flex-col gap-2" data-testid="shared-purposes">
      <h2 id="shared-purposes-title" className="mt-2 font-serif text-xl font-bold text-heading">
        {t("sharedWithMe")}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map(({ share, purpose }) => (
          <li key={purpose.id}>
            <Link href={`/app/purposes/${purpose.id}`} className={`${cardCls} block hover:bg-hover ${focusCls}`}>
              <span className="block break-words font-serif text-xl font-bold text-heading">{purpose.name}</span>
              {purpose.text && <span className={`block truncate text-sm ${mutedCls}`}>{purpose.text}</span>}
              <span className="mt-2 flex flex-wrap gap-1">
                <ShareBadge owner={share.owner} access={share.access} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** "Shared with me" groups as cards with the owner/level badge. Hidden when empty. */
export function SharedGroups({ shares }: { shares: IncomingShare[] }) {
  const t = useTranslations("sharing");
  const tg = useTranslations("groups");
  const items = shares.flatMap((s) => (s.resource === "group" && s.group ? [{ share: s, group: s.group }] : []));
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="shared-groups-title" className="flex flex-col gap-2" data-testid="shared-groups">
      <h2 id="shared-groups-title" className="mt-2 font-serif text-xl font-bold text-heading">
        {t("sharedWithMe")}
      </h2>
      <ul className="flex flex-col gap-2">
        {items.map(({ share, group }) => (
          <li key={group.id}>
            <Link href={`/app/groups/${group.id}`} className={`${cardCls} block hover:bg-hover ${focusCls}`}>
              <span className="block break-words font-serif text-xl font-bold text-heading">{group.name}</span>
              <span className={`block text-sm ${mutedCls}`}>{tg("entryCount", { count: group.entryCount })}</span>
              <span className="mt-2 flex flex-wrap gap-1">
                <ShareBadge owner={share.owner} access={share.access} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
