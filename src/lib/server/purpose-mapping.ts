import "server-only";
import { PurposeTags } from "@/lib/domain/plan";
import { PurposeGuided, type TripPurpose } from "@/lib/domain/purpose";
import { accessOf } from "@/lib/domain/sharing";
import { purposeTagsHash } from "@/lib/plan/hash";
import type { PurposeRow } from "./purpose-insert";

/** Tags count only while the hash of the current content matches (edited purposes are re-tagged). */
export function rowTags(row: PurposeRow, guided: PurposeGuided): TripPurpose["tags"] {
  if (row.parsed_tags == null || !row.parsed_hash) return null;
  try {
    const hash = purposeTagsHash({ text: row.text ?? undefined, constraints: row.constraints, guided });
    if (hash !== row.parsed_hash) return null;
  } catch {
    return null;
  }
  const tags = PurposeTags.safeParse(row.parsed_tags);
  return tags.success ? tags.data : null;
}

/**
 * The viewer's access: owner, the level of their purpose share, else `read` and not usable (a purpose that is readable
 * only because it sits on a trip shared with the viewer). Only owner and share row make a purpose usable (spec sharing 3.1).
 * `purpose_shares` is the embedded `purpose_shares(grantee_id, access)` (RLS: the viewer's own row, or every grant of an own purpose).
 */
export function rowToPurpose(row: PurposeRow, viewerId: string): TripPurpose {
  const guided = PurposeGuided.safeParse(row.guided);
  const guidedData = guided.success ? guided.data : {};
  const share = row.purpose_shares?.find((s) => s.grantee_id === viewerId);
  const access = accessOf(row.owner_id, viewerId, share?.access);
  return {
    id: row.id,
    ownerId: row.owner_id,
    access,
    usable: access === "owner" || share !== undefined,
    name: row.name,
    text: row.text ?? undefined,
    guided: guidedData,
    constraints: row.constraints,
    tags: rowTags(row, guidedData),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
