import { getTranslations, setRequestLocale } from "next-intl/server";
import { GroupEditor } from "@/components/groups/group-editor";
import { GroupView } from "@/components/groups/group-view";
import { viewerAgeRefs } from "@/components/groups/viewer-refs";
import { personLabel } from "@/components/sharing/helpers";
import { PeopleBox } from "@/components/sharing/people-box";
import { SharedHeader } from "@/components/sharing/shared-header";
import { cardCls } from "@/components/ui/styles";
import { berlinToday } from "@/lib/date";
import { withoutLinkedUserIds } from "@/lib/domain/group";
import { canEdit } from "@/lib/domain/sharing";
import { getGroup } from "@/lib/server/groups";
import { getProfile } from "@/lib/server/profile";
import { getUserSession } from "@/lib/server/session";
import { listSharedWithMe } from "@/lib/server/sharing";
import { unwrap } from "@/lib/unwrap";

export default async function EditGroupPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const [t, ts] = await Promise.all([getTranslations("groups"), getTranslations("sharing")]);
  const [group, profileRes, session] = await Promise.all([getGroup(id), getProfile(), getUserSession()]);
  const g = unwrap(group, locale);
  const profile = unwrap(profileRes, locale);
  const isOwner = g.access === "owner";
  // Recipient with a group share: who shared it and the share row for "Leave". A group seen only through a shared trip has
  // none: it opens read-only without "Leave" (spec group-sharing 4.2).
  const mine = !isOwner ? await listSharedWithMe() : null;
  const share = mine?.ok ? mine.data.find((s) => s.resource === "group" && s.resourceId === g.id) : undefined;
  const ownerLabel = share ? personLabel(share.owner) : (g.owner?.name ?? null);
  const today = berlinToday();
  const refs = viewerAgeRefs(g, { id: session?.userId ?? "", birthdate: profile.birthdate }, today);
  return (
    <main className="flex flex-col gap-4">
      <h1 className="text-3xl font-bold sm:text-4xl">{t("editTitle")}</h1>
      {share && <SharedHeader resource="group" owner={share.owner} access={share.access} shareId={share.id} />}
      {share && <p className="text-sm text-muted">{ts("sharedGroupHint")}</p>}
      {!isOwner && !share && <p className="text-sm text-muted">{ts("groupViaTripHint")}</p>}
      {canEdit(g.access) ? (
        <GroupEditor group={withoutLinkedUserIds(g)} profileBirthdate={profile.birthdate} refs={refs} ownerLabel={ownerLabel} />
      ) : (
        <>
          <p role="note" className="rounded-lg border border-info-line bg-info-bg p-3 text-sm text-info-fg">
            {ts("readOnlyNote")}
          </p>
          <GroupView group={g} refs={refs} date={today} ownerLabel={ownerLabel} />
        </>
      )}
      {isOwner && (
        <section aria-labelledby="group-share-title" className={`${cardCls} flex min-w-0 flex-col gap-3`}>
          <h2 id="group-share-title" className="text-xl font-bold">
            {ts("title")}
          </h2>
          <PeopleBox resource="group" resourceId={g.id} isDemo={profile.isDemo} isAdmin={profile.role === "admin"} />
        </section>
      )}
    </main>
  );
}
