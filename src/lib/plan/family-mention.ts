/**
 * Deterministic fallback for the `family_activities` interest (issue #142). Haiku sometimes tags "mit Kleinkind"
 * without it, and then no zoo, aquarium or water park reaches the plan. If the purpose text or a constraint names
 * children or a family, code puts the interest first after normalizeTags (added, or moved to the front), so the
 * MAX_INTEREST_QUERIES cap never drops it; guided interests still come before all tag interests
 * (`interestsForTrip`). Only `interests` changes: restaurant and café flags (`cuisine.kids`, `cafes`) stay an
 * explicit ask (activities spec addendum A4).
 *
 * Matching (de + en, whole words, case-insensitive):
 * - Kleinkind(er/ern), Kinder(n), Familie(n), Baby(s), Babies, toddler(s), kid(s), child, children, family,
 *   families; German compounds that start with "Familien" or "Kleinkind" (Familienurlaub, Kleinkindalter).
 *   "Kind"/"Kindes" only capitalized (the German noun; lowercase "kind" is English).
 * - Tochter/Sohn/Enkel(in)/daughter/son/grandchild only with a child age (under 14) right next to them:
 *   "Tochter (2,5)", "Sohn (4)", "2-jährige Tochter", "son, 3 years old". An adult daughter does not count.
 * - Not counted: a negated mention ("ohne Kinder", "keine kleinen Kinder", "no kids", "without children"),
 *   "-frei"/"-free"/"-los"/"-less" ("kinderfrei", "child-free"), and compounds with Kind-/Kinder- (Kindergeburtstag,
 *   Kinderbuch, Kindheit): they name a thing, not who travels. Known false positive: "Familienforschung".
 */
import type { PurposeTags } from "@/lib/domain/plan";

const FAMILY_WORDS =
  /(?<![\p{L}\p{N}])(?:kleinkind\p{L}*|kinder|kindern|familie|familien\p{L}*|babys?|babies|toddlers?|kids?|child|children|family|families)(?![\p{L}\p{N}])/giu;
const KIND = /(?<![\p{L}\p{N}])Kind(?:es)?(?![\p{L}\p{N}])/gu;
/** Up to two words before the match ("keine kleinen Kinder", "ohne die Kinder", "no small kids"). */
const NEGATED_BEFORE = /(?:^|[^\p{L}])(?:ohne|keine?[nmrs]?|kein|nicht|no|without|not|never)\s+(?:\p{L}+\s+)?$/iu;
const FREE_AFTER = /^-?(?:frei|free|los|less)/iu;

const REL = String.raw`(?:tochter|töchter\p{L}*|sohn|söhne\p{L}*|enkel\p{L}*|daughters?|sons?|grand(?:child(?:ren)?|sons?|daughters?))`;
const AGE = String.raw`(\d{1,2})(?:[.,]\d+)?`;
/** Relative + age after it: "Tochter (2,5)", "Sohn, 4 Jahre", "son, 3 years old". */
const REL_AGE_AFTER = new RegExp(
  String.raw`(?<![\p{L}])${REL}(?![\p{L}])\s*(?:\(\s*${AGE}[^)]*\)|,?\s*${AGE}\s*(?:jahre?|j\.|years?|yrs?|y\/o)(?![\p{L}]))`,
  "giu",
);
/** Age before it: "2-jährige Tochter", "3 Jahre alten Sohn", "4-year-old son", "4 year old daughter". */
const AGE_REL_BEFORE = new RegExp(
  String.raw`(?<![\p{N}])${AGE}\s*-?\s*(?:jährige?\p{L}*|jahre alte?\p{L}*|years?[- ]old|year[- ]old)\s+(?:\p{L}+\s+)?${REL}(?![\p{L}])`,
  "giu",
);
const CHILD_AGE = 14;

function plainMention(text: string, re: RegExp): boolean {
  for (const m of text.matchAll(re)) {
    const before = text.slice(0, m.index);
    const after = text.slice(m.index + m[0].length);
    if (!NEGATED_BEFORE.test(before) && !FREE_AFTER.test(after)) return true;
  }
  return false;
}

const childRelative = (text: string) =>
  [...text.matchAll(REL_AGE_AFTER), ...text.matchAll(AGE_REL_BEFORE)].some((m) => Number(m[1] ?? m[2]) < CHILD_AGE);

export function mentionsFamily(text: string | null | undefined): boolean {
  return !!text && (plainMention(text, FAMILY_WORDS) || plainMention(text, KIND) || childRelative(text));
}

/** Tags with `family_activities` first when one of `texts` mentions children or a family; otherwise unchanged. */
export function withFamilyFallback(tags: PurposeTags, texts: readonly (string | null | undefined)[]): PurposeTags {
  if (!texts.some(mentionsFamily) || tags.interests[0] === "family_activities") return tags;
  return { ...tags, interests: ["family_activities", ...tags.interests.filter((i) => i !== "family_activities")] };
}
