import type { Person, ShareAccess, ShareResource } from "@/lib/domain/sharing";
import { LeaveButton } from "./leave-button";
import { personLabel } from "./helpers";
import { ShareBadge } from "./share-badge";

/** Header strip of a shared trip or purpose for the recipient: who shared it, at which level, and "Leave". */
export function SharedHeader({
  resource,
  owner,
  access,
  shareId,
}: {
  resource: ShareResource;
  owner: Pick<Person, "name" | "email">;
  access: ShareAccess;
  /** Null when the share row could not be found (then there is nothing to leave). */
  shareId: string | null;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-testid="shared-header">
      <ShareBadge owner={owner} access={access} />
      {shareId && <LeaveButton resource={resource} shareId={shareId} ownerName={personLabel(owner)} />}
    </div>
  );
}
