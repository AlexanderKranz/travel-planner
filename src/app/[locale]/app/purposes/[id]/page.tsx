import { getTranslations, setRequestLocale } from "next-intl/server";
import { PurposeEditor } from "@/components/purposes/purpose-editor";
import { PeopleBox } from "@/components/sharing/people-box";
import { SharedHeader } from "@/components/sharing/shared-header";
import { btnSecondary, cardCls } from "@/components/ui/styles";
import { Link } from "@/i18n/navigation";
import { getProfile } from "@/lib/server/profile";
import { getPurpose } from "@/lib/server/purposes";
import { listSharedWithMe } from "@/lib/server/sharing";
import { unwrap } from "@/lib/unwrap";

export default async function EditPurposePage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const [t, ts, td] = await Promise.all([getTranslations("purposes"), getTranslations("sharing"), getTranslations("trips")]);
  const [purposeRes, profileRes] = await Promise.all([getPurpose(id), getProfile()]);
  const purpose = unwrap(purposeRes, locale);
  const profile = unwrap(profileRes, locale);
  const isOwner = purpose.access === "owner";
  // Recipient with a purpose share: who shared it and the share row for "Leave".
  const mine = !isOwner && purpose.usable ? await listSharedWithMe() : null;
  const share = mine?.ok ? mine.data.find((s) => s.resource === "purpose" && s.resourceId === purpose.id) : undefined;
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("editTitle")}</h1>
      {share && (
        <SharedHeader resource="purpose" owner={share.owner} access={share.access} shareId={share.id} />
      )}
      {!isOwner && purpose.usable && <p className="text-sm text-muted">{ts("sharedPurposeHint")}</p>}
      {purpose.usable && (
        <div>
          <Link href={`/app/trips/discover?purpose=${purpose.id}`} className={btnSecondary}>
            {td("discoverLink")}
          </Link>
        </div>
      )}
      <PurposeEditor purpose={purpose} />
      {isOwner && (
        <section aria-labelledby="purpose-share-title" className={`${cardCls} flex min-w-0 flex-col gap-3`}>
          <h2 id="purpose-share-title" className="text-xl font-bold">
            {ts("title")}
          </h2>
          <PeopleBox resource="purpose" resourceId={purpose.id} isDemo={profile.isDemo} isAdmin={profile.role === "admin"} />
        </section>
      )}
    </main>
  );
}
