import { setRequestLocale } from "next-intl/server";
import { StartGuide } from "@/components/start/start-guide";
import { getProfile } from "@/lib/server/profile";
import { listGroups } from "@/lib/server/groups";
import { listPurposes } from "@/lib/server/purposes";
import { listTrips } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";

/** Getting-started guide. Reachable any time; step status comes from the user's data. */
export default async function StartPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [profile, groups, purposes, trips] = await Promise.all([getProfile(), listGroups(), listPurposes(), listTrips()]);
  const p = unwrap(profile, locale);
  return (
    <StartGuide
      about={{
        displayName: p.displayName,
        locale: p.locale,
        homeAirports: p.homeAirports,
        birthdate: p.birthdate,
        home:
          p.homeLocation && p.homeTimezone
            ? { name: p.homeLocation, timezone: p.homeTimezone, ...(p.homeGeoId !== null ? { geoId: p.homeGeoId } : {}) }
            : null,
      }}
      facts={{
        homeAirports: p.homeAirports,
        birthdate: p.birthdate,
        homeLocation: p.homeLocation,
        groupCount: unwrap(groups, locale).length,
        purposeCount: unwrap(purposes, locale).length,
        tripCount: unwrap(trips, locale).length,
      }}
    />
  );
}
