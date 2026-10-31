import { describe, expect, it } from "vitest";
import { draftToInput } from "@/components/trips/trip-draft";
import { TripInput } from "@/lib/domain/trip";
import { buildTripDraft } from "./prefill";

const search = { id: "11111111-1111-4111-8111-111111111111", months: [3], origins: ["FRA"], purposeId: "22222222-2222-4222-8222-222222222222", groupId: null };
const card = { kind: "region" as const, geoId: 2513918, placeName: "Marbella", name: "Costa del Sol", admin1: "Andalusia" };

describe("buildTripDraft (D11)", () => {
  it("prefills destination, months, purpose and the hidden search id; no reason anywhere", () => {
    const d = buildTripDraft(search, { ...card, reason: "Flache Plätze und mildes Klima" } as typeof card, ["FRA", "MUC", "HAM"]);
    expect(d.destination).toEqual({
      mode: "geo",
      geoKind: "region",
      geoId: 2513918,
      placeName: "Marbella",
      placeLabel: "Marbella, Andalusia",
      name: "Costa del Sol",
      radiusKm: null,
    });
    expect(d.timing).toEqual({ mode: "months", startDate: "", months: [3] });
    expect(d.purposeId).toBe(search.purposeId);
    expect(d.destinationSearchId).toBe(search.id);
    expect(d.lengthDays).toBe(7);
    expect(d.title).toBe("");
    expect(d.notes).toBe("");
    expect(JSON.stringify(d)).not.toContain("mildes Klima");
  });

  it("no months -> no timing", () => {
    expect(buildTripDraft({ ...search, months: [] }, card, []).timing.mode).toBe("none");
  });

  it("origins equal to the profile's first two stay empty (home airports are used)", () => {
    const d = buildTripDraft({ ...search, origins: ["FRA", "MUC"] }, card, ["FRA", "MUC", "HAM"]);
    expect(d).toMatchObject({ wantsFlights: true, useHomeAirports: true, originAirports: [] });
  });

  it("other origins are carried over", () => {
    const d = buildTripDraft({ ...search, origins: ["HAM"] }, card, ["FRA", "MUC"]);
    expect(d).toMatchObject({ wantsFlights: true, useHomeAirports: false, originAirports: ["HAM"] });
  });

  it("no origins -> no flights", () => {
    const d = buildTripDraft({ ...search, origins: [] }, card, ["FRA"]);
    expect(d).toMatchObject({ wantsFlights: false, originAirports: [] });
  });

  it("a deleted purpose or no group gives empty ids", () => {
    const d = buildTripDraft({ ...search, purposeId: null, groupId: null }, card, []);
    expect(d.purposeId).toBe("");
    expect(d.groupId).toBe("");
  });

  it("the draft turns into a valid TripInput that carries destinationSearchId and sends no coordinates", () => {
    const input = draftToInput(buildTripDraft(search, card, ["FRA"]));
    const parsed = TripInput.parse(input);
    expect(parsed.destinationSearchId).toBe(search.id);
    expect(parsed.notes).toBeUndefined();
    expect(parsed.destination).not.toHaveProperty("lat");
    expect(parsed.timing).toEqual({ kind: "months", months: [3] });
  });
});

describe("buildTripDraft: only a clean name (review round)", () => {
  it("a stored name with a banned fact falls back to the verified place name", () => {
    const d = buildTripDraft(search, { ...card, name: "Costa del Sol ab 49 € Direktflug" }, []);
    expect(d.destination).toMatchObject({ mode: "geo", name: "Marbella" });
  });
});
