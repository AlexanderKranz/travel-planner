/**
 * Deterministic fallback for the `family_activities` interest (issue #142). Haiku sometimes tags "mit Kleinkind"
 * without it, and then no zoo, aquarium or water park reaches the plan. If the purpose text or a constraint names
 * children or a family, code adds the interest after normalizeTags. Only `interests` changes: restaurant and café
 * flags (`cuisine.kids`, `cafes`) stay an explicit ask (activities spec addendum A4).
 *
 * Matching (de + en, whole words, case-insensitive): Kleinkind(er/ern), Kinder(n), Familie(n), Baby(s), Babies,
 * toddler(s), kid(s), child, children, family, families; German compounds that start with "Familien" or
 * "Kleinkind" (Familienurlaub, Kleinkindalter). "Kind"/"Kindes" only capitalized (the German noun; lowercase "kind"
 * is English). Compounds with "Kinder"/"Kind" do not count (Kindergeburtstag, Kinderbuch, Kindheit, Kindergarten):
 * they name a thing, not who travels. Known false positive: "Familienforschung" (genealogy) adds family places as
 * candidates, which only widens the place lookup.
 */
import type { PurposeTags } from "@/lib/domain/plan";

const FAMILY_WORDS =
  /(?<![\p{L}\p{N}])(?:kleinkind\p{L}*|kinder|kindern|familie|familien\p{L}*|babys?|babies|toddlers?|kids?|child|children|family|families)(?![\p{L}\p{N}])/iu;
const KIND = /(?<![\p{L}\p{N}])Kind(?:es)?(?![\p{L}\p{N}])/u;

export function mentionsFamily(text: string | null | undefined): boolean {
  return !!text && (FAMILY_WORDS.test(text) || KIND.test(text));
}

/** Tags with `family_activities` added (first, so the MAX_INTEREST_QUERIES cap never drops it) when one of `texts` mentions children or a family. */
export function withFamilyFallback(tags: PurposeTags, texts: readonly (string | null | undefined)[]): PurposeTags {
  if (tags.interests.includes("family_activities") || !texts.some(mentionsFamily)) return tags;
  return { ...tags, interests: ["family_activities", ...tags.interests] };
}
