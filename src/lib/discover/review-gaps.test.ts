import { describe, expect, it } from "vitest";
import type { TripPurpose } from "@/lib/domain/purpose";
import { buildIdeaInput } from "./input";
import { ideasInputHash } from "./hash";
import { kindOf } from "./names";
import { cleanReason } from "./reason";

/**
 * QA review of branch feat/find-destinations. Two kinds of test:
 * - plain `it`: behaviour that holds today and must keep holding;
 * - the former `it.fails` gaps, fixed on this branch and now plain tests.
 */

const removed = (s: string) => cleanReason(s).removed;

describe("REASON_BANNED: what is caught", () => {
  it.each([
    "Nur 2 Stunden Flug von Frankfurt",
    "In 2h erreichbar",
    "ca. 2,5 Std. entfernt",
    "Direktflüge ab Frankfurt",
    "Flugzeit unter drei Stunden",
    "Per Flieger schnell erreichbar",
    "ganzjährig geöffnet",
    "Öffnungszeiten täglich",
    "ab 99 Euro pro Nacht",
    "ab 99€",
    "20 Minuten vom Strand",
    "3 km vom Zentrum",
    "direct flight from Munich",
    "opening hours are generous",
    "3 hours by train",
  ])("removes %s", (s) => expect(removed(s)).toBe(true));

  it.each([
    "Tagesausflüge ins Umland",
    "Ausflugsziel für Familien",
    "Zwei Flüsse und eine schöne Altstadt",
    "Perfekt für Golfer im Frühling",
    "Familienfreundlicher Sandstrand",
    "Great beaches and a relaxed pace",
  ])("keeps %s", (s) => expect(removed(s)).toBe(false));

  it("known and accepted false positives (spec: a false positive costs one sentence)", () => {
    expect(removed("Perfekt für 2 Stunden Strand am Tag")).toBe(true);
    expect(removed("Fliegenfischen am Fluss")).toBe(true);
    expect(removed("fly fishing in the river")).toBe(true);
    expect(removed("10 km Sandstrand")).toBe(true);
  });
});

describe("REASON_BANNED: evasions (defects)", () => {
  // Each of these states a travel time, a price, an airline or opening hours and must be removed.
  it("English abbreviations: 45 mins by car", () => expect(removed("45 mins by car")).toBe(true));
  it("English abbreviations: 2 hrs away", () => expect(removed("2 hrs away")).toBe(true));
  it("compound minutes: 10 Autominuten vom Strand", () => expect(removed("10 Autominuten vom Strand")).toBe(true));
  it("hyphenated: a 3-hour drive", () => expect(removed("a 3-hour drive from the coast")).toBe(true));
  it("number words: zwei Stunden entfernt", () => expect(removed("zwei Stunden entfernt")).toBe(true));
  it("number words: two hours away", () => expect(removed("two hours away")).toBe(true));
  it("airline name: Ryanair", () => expect(removed("Mit Ryanair ab Frankfurt")).toBe(true));
  it("non-stop with hyphen", () => expect(removed("Non-stop ab Frankfurt")).toBe(true));
  it("price: 99,- Euro", () => expect(removed("ab 99,- Euro pro Nacht")).toBe(true));
  it("price: other currencies", () => expect(removed("ab 80 Dollar")).toBe(true));
  it("opening hours: Uhr", () => expect(removed("Mo-Fr 9-17 Uhr")).toBe(true));
  it("opening hours: 24/7", () => expect(removed("open 24/7")).toBe(true));
  it("opening hours: opening times", () => expect(removed("Opening times 9 to 5")).toBe(true));
  it("Unicode: decomposed u + combining diaeresis (Flug)", () => expect(removed("Flüg nach Rom")).toBe(true));
  it("Unicode: zero-width space inside the word", () => expect(removed("Flu​g nach Rom")).toBe(true));
  it("Unicode: fullwidth digits", () => expect(removed("２ Stunden entfernt")).toBe(true));
});

const base = { id: "p", name: "x", constraints: [], text: null, guided: null, tags: null, createdAt: "", updatedAt: "" } as unknown as TripPurpose;
const inputFor = (over: Partial<TripPurpose>, extra: { origins?: string[]; radiusKm?: number } = {}) =>
  buildIdeaInput({ lang: "de", purpose: { ...base, ...over }, months: [], origins: extra.origins ?? [], radiusKm: extra.radiusKm, group: null, profileBirthdate: null, today: "2026-11-01" });
const modelSees = (over: Partial<TripPurpose>) => JSON.stringify(inputFor(over));

describe("flight limit never reaches the model", () => {
  it("is stripped from constraints and from the summary when phrased with Flug / flight", () => {
    expect(modelSees({ constraints: ["Flugzeit max 2 Stunden"], text: "Golf. Flug max 2h. Sonne." })).not.toMatch(/Flug|2 Stunden|2h/);
    expect(modelSees({ constraints: ["Direktflug nötig"] })).not.toMatch(/Direktflug/);
  });
  it("hard and soft tags are stripped too", () => {
    const tags = { v: 1, interests: ["golf"], custom: [], hard: ["max 2h flight"], soft: ["Flugzeit kurz"], summary: "Golfreise. Kurzer Flug." };
    const seen = modelSees({ tags } as unknown as Partial<TripPurpose>);
    expect(seen).not.toMatch(/flight|Flug/i);
    expect(seen).toContain("Golfreise");
  });
  it("the km radius derived from the limit IS sent as a hint (spec D2/section 4); noted for the owner", () => {
    expect(inputFor({}, { origins: ["FRA"], radiusKm: 1330 }).radiusKm).toBe(1330);
  });

  // Defects: the limit or travel time leaks through other phrasings.
  it("verb form: maximal 2 Stunden fliegen", () => expect(modelSees({ constraints: ["maximal 2 Stunden fliegen"] })).not.toMatch(/2 Stunden/));
  it("noun Flieger: nicht länger als 3 Stunden im Flieger", () => expect(modelSees({ constraints: ["nicht länger als 3 Stunden im Flieger"] })).not.toMatch(/3 Stunden/));
  it("English: no more than 2.5h in the air", () => expect(modelSees({ constraints: ["no more than 2.5h in the air"] })).not.toMatch(/2\.5h/));
  it("custom guided interest keeps its flight text", () =>
    expect(modelSees({ guided: { interests: ["golf", "Direktflug unter 2 Stunden"] } } as unknown as Partial<TripPurpose>)).not.toMatch(/Direktflug|2 Stunden/));
  it("tag custom interest keeps its flight text", () =>
    expect(modelSees({ tags: { v: 1, interests: ["golf"], custom: ["Flugzeit unter 2 Stunden"], hard: [], soft: [], summary: "Golf" } } as unknown as Partial<TripPurpose>)).not.toMatch(/Flugzeit/));
});

describe("cache hash", () => {
  it("two airports of the same city give two different lists (LHR vs LGW both send from: [London])", () => {
    const a = inputFor({}, { origins: ["LHR"], radiusKm: 1330 });
    const b = inputFor({}, { origins: ["LGW"], radiusKm: 1330 });
    expect(ideasInputHash(a)).not.toBe(ideasInputHash(b));
  });
  it("different cities differ", () => {
    expect(ideasInputHash(inputFor({}, { origins: ["FRA"], radiusKm: 1330 }))).not.toBe(ideasInputHash(inputFor({}, { origins: ["MUC"], radiusKm: 1330 })));
  });
});

describe("kind city or region", () => {
  it("name and anchor equal -> city", () => expect(kindOf("Palma", "Palma")).toBe("city"));
  it("a translated city name is not a region (name Lissabon, anchor Lisbon)", () => expect(kindOf("Lissabon", "Lisbon", "Lissabon")).toBe("city"));
});
