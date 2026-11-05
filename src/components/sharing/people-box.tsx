import { getTranslations } from "next-intl/server";
import { ErrorBanner } from "@/components/ui/error-banner";
import type { ShareResource } from "@/lib/domain/sharing";
import { listGrants, listShareCandidates } from "@/lib/server/sharing";
import { PeopleShare } from "./people-share";

/**
 * Server wrapper of the "People" box (owner only): loads the grants, and for admins the user list. The demo account
 * gets the box disabled (it can neither share nor receive).
 */
export async function PeopleBox({
  resource,
  resourceId,
  isDemo,
  isAdmin,
}: {
  resource: ShareResource;
  resourceId: string;
  isDemo: boolean;
  isAdmin: boolean;
}) {
  const t = await getTranslations("sharing");
  if (isDemo) {
    return <PeopleShare resource={resource} resourceId={resourceId} grants={[]} candidates={null} disabledReason={t("demoDisabled")} />;
  }
  const [grants, candidates] = await Promise.all([listGrants(resource, resourceId), isAdmin ? listShareCandidates() : null]);
  if (!grants.ok) return <ErrorBanner error={grants.error} />;
  return (
    <PeopleShare
      resource={resource}
      resourceId={resourceId}
      grants={grants.data}
      candidates={candidates?.ok ? candidates.data : null}
      disabledReason={null}
    />
  );
}
