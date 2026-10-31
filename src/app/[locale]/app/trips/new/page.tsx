import { getTranslations, setRequestLocale } from "next-intl/server";
import { TripForm } from "@/components/trips/trip-form";
import { linkCls, mutedCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { buildTripDraft } from "@/lib/discover/prefill";
import { listCountries } from "@/lib/integrations/countries";
import { getDestinationSearch } from "@/lib/server/discover/pipeline";
import { listGroups } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { listPurposes } from "@/lib/server/purposes";
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
  const [groups, purposes, profile] = await Promise.all([listGroups(), listPurposes(), getProfile()]);
  const profileData = unwrap(profile, locale);

  // Prefill from a suggestion (spec section 7). The row is read through RLS; an unknown search or card simply gives
  // the normal empty form. Nothing is created until the user saves.
  const searchId = first(sp.search);
  const cardId = first(sp.card);
  let initialDraft;
  let backToList: string | null = null;
  if (searchId && cardId) {
    const res = await getDestinationSearch(searchId);
    const card = res.ok ? res.data.cards.find((c) => c.id === cardId) : undefined;
    if (res.ok && card) {
      initialDraft = buildTripDraft(res.data, card, profileData.homeAirports);
      backToList = res.data.id;
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
        countryCodes={listCountries().map((c) => c.code)}
        profileBirthdate={profileData.birthdate}
        initialDraft={initialDraft}
      />
    </main>
  );
}
