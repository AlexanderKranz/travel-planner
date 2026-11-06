import { describe, expect, it } from "vitest";
import type { PurposeTags } from "@/lib/domain/plan";
import { mentionsFamily, withFamilyFallback } from "./family-mention";

const tags = (over: Partial<PurposeTags> = {}): PurposeTags => ({ v: 2, interests: ["christmas_markets", "cruise"], custom: [], hard: [], soft: [], summary: "s", ...over });

describe("mentionsFamily (issue #142)", () => {
  it.each([
    "Advents-Flusskreuzfahrt mit Kleinkind.",
    "Urlaub mit zwei Kleinkindern",
    "Die Kinder wollen ins Hallenbad",
    "mit den kindern ans Meer",
    "Familienurlaub am See",
    "mit der Familie",
    "Wir reisen mit Baby",
    "Family holiday with our two kids",
    "toddler nap midday",
    "children love animals",
    "Ein Kind (3) reist mit",
    "kid-friendly trip",
    // A child relative only with a child age right next to it (CodeRabbit on #143).
    "Mit unserer Tochter (2,5): bei Regen in einen Indoorspielplatz",
    "Unser Sohn (4) liebt Tiere",
    "mit unserer 2-jährigen Tochter",
    "with our son, 3 years old",
    "our 4-year-old daughter",
    "Oma mit Enkelin (7)",
    "Wir fahren ohne Hund, aber mit Kindern",
  ])("counts %s", (t) => expect(mentionsFamily(t)).toBe(true));

  it.each([
    "Kindergeburtstag in Berlin feiern",
    "Kinderbuchmuseum besuchen",
    "Orte meiner Kindheit",
    "some kind of beach trip",
    "Golftrip mit einem Freund",
    "Städtetrip zu zweit",
    // Negated or "-free" mentions.
    "Wochenende ohne Kinder",
    "keine Kinder dabei",
    "Wir haben keine kleinen Kinder dabei",
    "no kids this time",
    "without children",
    "kinderfreies Hotel, ganz kinderfrei",
    "child-free resort",
    // Adult relatives.
    "Reise mit meiner Tochter (35)",
    "Besuch bei unserem Sohn in Hamburg",
    "with my daughter, 28 years old",
    "",
    null,
  ])("does not count %s", (t) => expect(mentionsFamily(t)).toBe(false));
});

describe("withFamilyFallback", () => {
  it("adds family_activities when the text or a constraint mentions children", () => {
    expect(withFamilyFallback(tags(), ["Kreuzfahrt mit Kleinkind"]).interests).toEqual(["family_activities", "christmas_markets", "cruise"]);
    expect(withFamilyFallback(tags(), [undefined, "toddler nap midday"]).interests).toContain("family_activities");
  });

  it("keeps the tags unchanged otherwise, and never twice", () => {
    const t = tags();
    expect(withFamilyFallback(t, ["Weihnachtsmärkte"])).toBe(t);
    const f = tags({ interests: ["family_activities"] });
    expect(withFamilyFallback(f, ["mit Kindern"])).toBe(f);
  });

  it("moves an existing family_activities to the front when the text mentions family", () => {
    const t = tags({ interests: ["museums", "beach", "family_activities"] });
    expect(withFamilyFallback(t, ["Familienurlaub"]).interests).toEqual(["family_activities", "museums", "beach"]);
    // Without a mention Haiku's order stays.
    expect(withFamilyFallback(t, ["Strand und Museen"])).toBe(t);
  });

  it("never touches restaurant or café flags (A4: child-friendly only on explicit ask)", () => {
    const out = withFamilyFallback(tags({ cuisine: { local: true, include: [], exclude: [] } }), ["mit Kleinkind"]);
    expect(out.cuisine).toEqual({ local: true, include: [], exclude: [] });
    expect(out).not.toHaveProperty("cafes");
  });
});
