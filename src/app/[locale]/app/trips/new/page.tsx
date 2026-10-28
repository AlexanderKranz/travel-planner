import { getTranslations, setRequestLocale } from "next-intl/server";
import { TripForm } from "@/components/trips/trip-form";
import { listCountries } from "@/lib/integrations/countries";
import { listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { listPurposes } from "@/lib/server/purposes";
import { unwrap } from "@/lib/unwrap";

// The server action's after() facts warm-up runs within this route's budget.
export const maxDuration = 300;

export default async function NewTripPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("trips");
  const [groups, purposes, profile] = await Promise.all([listGroups(), listPurposes(), getProfile()]);
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold">{t("newTitle")}</h1>
      <TripForm
        groups={unwrap(groups, locale).map(({ id, name }) => ({ id, name }))}
        purposes={unwrap(purposes, locale).map(({ id, name }) => ({ id, name }))}
        countryCodes={listCountries().map((c) => c.code)}
        hasHomeAirports={unwrap(profile, locale).homeAirports.length > 0}
      />
    </main>
  );
}
