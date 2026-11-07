import "server-only";
import { ageRefs, type AgeRefs } from "@/lib/group";
import { loadGroupOwnerBirthdate } from "./owner-context";

/**
 * The one place that builds `AgeRefs` for a trip (docs/specs/group-sharing.md 1.4), shared by the plan pipeline and the
 * trip page so a plan and the page can never disagree. T = G (no saved group, own group): no extra read. G != T: the group
 * owner's profile birthdate is read with the secret key (owner-context.ts); call this only AFTER the group was read through
 * RLS as the viewer. Null when that profile cannot be read; callers fail closed (pipeline) or fall back (page).
 */
export async function loadAgeRefs(a: {
  tripOwnerId: string;
  tripOwnerBirthdate: string | null;
  group: { ownerId?: string; entries: { id?: string; isSelf?: boolean; linkedUserId?: string | null }[] } | null;
}): Promise<AgeRefs | null> {
  const groupOwnerId = a.group?.ownerId && a.group.ownerId !== a.tripOwnerId ? a.group.ownerId : null;
  let groupOwnerBirthdate = a.tripOwnerBirthdate;
  if (groupOwnerId) {
    const go = await loadGroupOwnerBirthdate(groupOwnerId);
    if (!go) return null;
    groupOwnerBirthdate = go.birthdate;
  }
  return ageRefs({
    tripOwnerId: a.tripOwnerId,
    tripOwnerBirthdate: a.tripOwnerBirthdate,
    groupOwnerId,
    groupOwnerBirthdate,
    entries: a.group?.entries ?? [],
  });
}
