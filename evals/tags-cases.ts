/**
 * Purpose-tag cases for addendum 1 (activities spec): family places, cafés and `cuisine.kids` only on an explicit
 * ask. Shared by the live recorder (`tags-cases.eval.ts`) and the CI replay (`tags-cases.test.ts`). Pure.
 */
import type { PurposeTags } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import type { CheckResult } from "./checks";

export type TagsCase = { id: string; text: string; check: (t: PurposeTags) => CheckResult[] };

const check = (name: string, ok: boolean, detail?: string): CheckResult => (ok ? { name, ok } : { name, ok, detail });
const types = (t: PurposeTags) => (t.activities ?? []).flatMap((w) => w.types);
const noKids = (t: PurposeTags) => check("no cuisine.kids", t.cuisine?.kids !== true, JSON.stringify(t.cuisine ?? null));
/** Issue #142: a child in the text always yields family_activities (code fallback after Haiku). */
const family = (t: PurposeTags) => check("family_activities", t.interests.includes("family_activities"), t.interests.join(","));

export const TAGS_CASES: TagsCase[] = [
  {
    // The cruise fixture's purpose: a toddler travels, nothing asks for special restaurants.
    id: "family-alone-de",
    text: "Advents-Flusskreuzfahrt mit Kleinkind. Weihnachtsmärkte, entspanntes Tempo, Mittagsschlaf an Bord einplanen.",
    check: (t) => [noKids(t), check("no cafes", t.cafes !== true), family(t)],
  },
  {
    id: "family-food-en",
    text: "Family holiday with our two kids (4 and 7). We love good local food and easy walks.",
    check: (t) => [noKids(t), check("cuisine.local", t.cuisine?.local === true, JSON.stringify(t.cuisine ?? null)), family(t)],
  },
  {
    id: "kids-restaurant-de",
    text: "Wochenende in Limburg mit Kleinkind. Abends bitte ein kinderfreundliches Restaurant mit Spielecke.",
    check: (t) => [check("cuisine.kids", t.cuisine?.kids === true, JSON.stringify(t.cuisine ?? null)), family(t)],
  },
  {
    id: "indoor-play-de",
    text: "Mit unserer Tochter (2,5): bei Regen in einen Indoorspielplatz, sonst auf einen Spielplatz am Fluss.",
    check: (t) => [
      check("indoor_play wish", types(t).includes("indoor_play"), JSON.stringify(t.activities ?? null)),
      check("playground wish", types(t).includes("playground"), JSON.stringify(t.activities ?? null)),
      noKids(t),
    ],
  },
  {
    id: "swimming-de",
    text: "Familienurlaub, die Kinder wollen unbedingt ins Hallenbad oder Spaßbad.",
    check: (t) => [check("swimming wish", types(t).includes("swimming"), JSON.stringify(t.activities ?? null)), noKids(t), family(t)],
  },
  {
    id: "cafe-de",
    text: "Städtetrip zu zweit, nachmittags Kaffee und Kuchen in einem gemütlichen Café.",
    check: (t) => [check("cafes", t.cafes === true), noKids(t)],
  },
];

export const casePurpose = (c: TagsCase): TripPurpose => ({
  id: `tags-case-${c.id}`,
  ownerId: "eval",
  access: "owner",
  usable: true,
  name: c.id,
  text: c.text,
  guided: {},
  constraints: [],
  tags: null,
  createdAt: "2026-11-06T00:00:00.000Z",
  updatedAt: "2026-11-06T00:00:00.000Z",
});
