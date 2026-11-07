import { birthdateForAge } from "@/components/sharing/helpers";
import type { TravelGroup } from "@/lib/domain/group";
import { ageRefs, ownAgeRefs, type AgeRefs } from "@/lib/group";

/**
 * The age anchors of the group page for the VIEWER, as if they were the trip owner (docs/specs/group-sharing.md G24):
 * the owner of the group sees their own birthdate for both `is_self` and "about my age"; a recipient sees the owner's
 * birthdate on the `is_self` row (only sent when the group has one) and "about my age" = their claimed entry (falling back
 * to their own profile birthdate), or the group owner until they claimed one. When the server sent the owner's age but no
 * birthdate, the age stands in (never shown, there is no `is_self` row to show it on).
 */
export function viewerAgeRefs(
  group: Pick<TravelGroup, "ownerId" | "access" | "owner" | "entries"> | null,
  viewer: { id: string; birthdate: string | null },
  today: string,
): AgeRefs {
  if (!group || group.access === "owner" || !group.owner) return ownAgeRefs(viewer.birthdate);
  const o = group.owner;
  const ownerBirthdate = o.birthdate ?? (o.ageToday === null ? null : birthdateForAge(o.ageToday, today));
  return ageRefs({
    tripOwnerId: viewer.id,
    tripOwnerBirthdate: viewer.birthdate,
    groupOwnerId: group.ownerId,
    groupOwnerBirthdate: ownerBirthdate,
    entries: group.entries,
  });
}
