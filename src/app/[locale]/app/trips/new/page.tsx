import { getTranslations, setRequestLocale } from "next-intl/server";
import { sharedGroupOptions, sharedPurposeOptions } from "@/components/sharing/helpers";
import { TripForm } from "@/components/trips/trip-form";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { buildTripDraft } from "@/lib/discover/prefill";
import { listCountries } from "@/lib/integrations/countries";
import { getDestinationSearch } from "@/lib/server/discover/pipeline";
import { listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { listPurposes } from "@/lib/server/purposes";
import { listSharedWithMe } from "@/lib/server/sharing";
import { unwrap } from "@/lib/unwrap";

// The server action's after() facts warm-up runs within this route's budget.
export const maxDuration = 300;

const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function NewTripPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ search?: string | string[]; card?: string | string[] }>;
}) {
  const { locale } = await params;
  const sp = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("trips");
  const [groups, purposes, profile, incoming] = await Promise.all([listGroups(), listPurposes(), getProfile(), listSharedWithMe()]);
  const profileData = unwrap(profile, locale);

  // Prefill from a suggestion (spec section 7). The row is read through RLS; an unknown search or card simply gives
  // the normal empty form. Nothing is created until the user saves.
  const searchId = first(sp.search);
  const cardId = first(sp.card);
  let initialDraft;
  let backToList: string | null = null;
  let purposeFromSearch = false;
  if (searchId && cardId) {
    const res = await getDestinationSearch(searchId);
    const card = res.ok ? res.data.cards.find((c) => c.id === cardId) : undefined;
    if (res.ok && card) {
      // Only purposes the user can still use and the picker can show: own ones and shares from active owners (RLS
      // hides a disabled owner's shares). A list that failed to load verifies nothing, so its purposes are dropped and
      // the user picks again, instead of submitting an id that createTrip would reject.
      const usablePurposeIds = [
        ...(purposes.ok ? purposes.data.map((p) => p.id) : []),
        ...(incoming.ok ? sharedPurposeOptions(incoming.data).map((p) => p.id) : []),
      ];
      // Same for groups: own ones and group shares (either level); a group seen only through a shared trip is not in
      // the picker, and a draft must not carry an id the select cannot show.
      const usableGroupIds = [
        ...(groups.ok ? groups.data.map((g) => g.id) : []),
        ...(incoming.ok ? sharedGroupOptions(incoming.data).map((g) => g.id) : []),
      ];
      initialDraft = buildTripDraft(res.data, card, profileData.homeAirports, usablePurposeIds, usableGroupIds);
      backToList = res.data.id;
      // An unsaved typed purpose becomes the one-off purpose text in buildTripDraft; the form says so (P8).
      purposeFromSearch = res.data.purposeId === null && !!res.data.purposeText;
    }
  }

  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("newTitle")}</h1>
      {backToList ? (
        <p className={`text-sm ${mutedCls}`}>
          {t("form.fromSuggestion")}{" "}
          <Link href={`/app/trips/discover/${backToList}`} className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("backToSuggestions")}
          </Link>
        </p>
      ) : (
        <p className={`text-sm ${mutedCls}`}>
          {t("discoverHint")}{" "}
          <Link href="/app/trips/discover" className={`${linkCls} inline-flex min-h-11 items-center`}>
            {t("discoverLink")}
          </Link>
        </p>
      )}
      <TripForm
        groups={unwrap(groups, locale).map(({ id, name }) => ({ id, name }))}
        purposes={unwrap(purposes, locale).map(({ id, name }) => ({ id, name }))}
        sharedPurposes={incoming.ok ? sharedPurposeOptions(incoming.data) : []}
        sharedGroups={incoming.ok ? sharedGroupOptions(incoming.data) : []}
        countryCodes={listCountries().map((c) => c.code)}
        profileBirthdate={profileData.birthdate}
        initialDraft={initialDraft}
        purposeFromSearch={purposeFromSearch}
      />
    </main>
  );
}
