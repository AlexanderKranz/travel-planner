import type { PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import { purposeTagsHash } from "@/lib/plan/hash";

/**
 * A purpose typed into "Find destinations" (spec docs/specs/find-destinations.md section 13.2). It is a transient
 * TripPurpose that is never written to `trip_purposes`; it runs through the same tag and input code as a saved one.
 */

export const ONE_OFF_LABEL_MAX = 60;

/** Whitespace collapsed, at most 60 characters (the ellipsis included) cut at a word boundary, "…" when cut. Code, not the LLM. */
export function oneOffLabel(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  if (chars.length <= ONE_OFF_LABEL_MAX) return flat;
  const keep = ONE_OFF_LABEL_MAX - 1;
  let end = keep;
  // Cut at the last space inside the window unless the cut already falls between two words.
  if (chars[keep] !== " ") {
    const space = chars.lastIndexOf(" ", keep);
    if (space > 0) end = space;
  }
  const cut = chars.slice(0, end).join("").replace(/[\s,;:.\-–]+$/u, "");
  return `${cut}…`;
}

/** id "", name `oneOffLabel(text)`, the text, no guided fields or constraints; timestamps "". Never saved. */
export function oneOffPurpose(text: string, tags: PurposeTags | null): TripPurpose {
  return {
    id: "",
    name: oneOffLabel(text),
    text: text.trim(),
    guided: {},
    constraints: [],
    tags,
    createdAt: "",
    updatedAt: "",
  };
}

/** = `purposeTagsHash` of a saved purpose with the same text and no constraints or custom interests. */
export function oneOffTagsHash(text: string): string {
  return purposeTagsHash({ text, constraints: [], guided: {} });
}
