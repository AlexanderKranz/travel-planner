import { getTranslations, setRequestLocale } from "next-intl/server";
import { personLabel, sharedGroupOptions, sharedPurposeOptions } from "@/components/sharing/helpers";
import { TripForm } from "@/components/trips/trip-form";
import { redirect } from "@/i18n/navigation";
import { listCountries } from "@/lib/integrations/countries";
import { getGroup, listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { oneOffLabel } from "@/lib/discover/one-off";
import { getPurpose, listPurposes } from "@/lib/server/purposes";
import { listSharedWithMe } from "@/lib/server/sharing";
import { getTrip } from "@/lib/server/trips";
import { unwrap } from "@/lib/unwrap";

// The server action's after() facts warm-up runs within this route's budget.
export const maxDuration = 300;

export default async function EditTripPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("trips");
  const [tripRes, groups, purposes, profile, incoming] = await Promise.all([
    getTrip(id),
    listGroups(),
    listPurposes(),
    getProfile(),
    listSharedWithMe(),
  ]);
  const trip = unwrap(tripRes, locale);
  // A read grantee has nothing to edit: back to the trip.
  if (trip.access === "read") redirect({ href: `/app/trips/${trip.id}`, locale });
  const shares = incoming.ok ? incoming.data : [];
  // A write grantee sees the group and purpose as text (read through the share, not the own lists).
  const [groupRes, purposeRes] =
    trip.access === "owner"
      ? [null, null]
      : await Promise.all([trip.groupId ? getGroup(trip.groupId) : null, trip.purposeId ? getPurpose(trip.purposeId) : null]);
  const owner = shares.find((s) => s.resource === "trip" && s.resourceId === trip.id)?.owner;
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("editTitle")}</h1>
      <TripForm
        trip={trip}
        groups={unwrap(groups, locale).map(({ id, name }) => ({ id, name }))}
        purposes={unwrap(purposes, locale).map(({ id, name }) => ({ id, name }))}
        sharedPurposes={sharedPurposeOptions(shares)}
        sharedGroups={sharedGroupOptions(shares)}
        ownerName={owner ? personLabel(owner) : undefined}
        ownerOnlyValues={
          trip.access === "owner"
            ? undefined
            : { group: groupRes?.ok ? groupRes.data.name : (trip.groupText ?? null), purpose: purposeRes?.ok ? purposeRes.data.name : (trip.purposeText ? oneOffLabel(trip.purposeText) : null) }
        }
        countryCodes={listCountries().map((c) => c.code)}
        profileBirthdate={unwrap(profile, locale).birthdate}
      />
    </main>
  );
}
