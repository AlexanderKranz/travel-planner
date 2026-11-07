import { describe, expect, it } from "vitest";
import { draftToInput, ONE_OFF_PURPOSE } from "@/components/trips/trip-draft";
import { TripInput } from "@/lib/domain/trip";
import { buildTripDraft } from "./prefill";

const search = { id: "11111111-1111-4111-8111-111111111111", months: [3], origins: ["FRA"], purposeId: "22222222-2222-4222-8222-222222222222", groupId: null };
const card = { kind: "region" as const, geoId: 2513918, placeName: "Marbella", name: "Costa del Sol", admin1: "Andalusia" };

describe("buildTripDraft: one-off purpose (trip-purpose-text P8)", () => {
  const reasonCard = { ...card, reason: "Flache Plätze und mildes Klima" } as typeof card;
  it("an unsaved one-off becomes the one-off purpose text, notes stay empty; never the reason", () => {
    const d = buildTripDraft({ ...search, purposeId: null, purposeText: "Golf mit einem Freund" }, reasonCard, ["FRA"]);
    expect(d.purposeId).toBe(ONE_OFF_PURPOSE);
    expect(d.purposeText).toBe("Golf mit einem Freund");
    expect(d.notes).toBe("");
    expect(JSON.stringify(d)).not.toContain("mildes Klima");
  });
  it("a saved or linked purpose keeps the text empty, also when the text is still on the row", () => {
    expect(buildTripDraft({ ...search, purposeText: null }, reasonCard, []).purposeText).toBe("");
    const linked = buildTripDraft({ ...search, purposeText: "Golf mit einem Freund" }, reasonCard, []);
    expect(linked.purposeId).toBe(search.purposeId);
    expect(linked.purposeText).toBe("");
    expect(linked.notes).toBe("");
  });
  it("a deleted purpose without text stays empty", () => {
    const d = buildTripDraft({ ...search, purposeId: null, purposeText: null }, reasonCard, []);
    expect(d).toMatchObject({ purposeId: "", purposeText: "", notes: "" });
  });
  it("the one-off text passes TripInput validation and is sent as purposeText", () => {
    const d = buildTripDraft({ ...search, purposeId: null, purposeText: "Golf mit einem Freund" }, card, ["FRA"]);
    const parsed = TripInput.parse(draftToInput(d));
    expect(parsed.purposeText).toBe("Golf mit einem Freund");
    expect(parsed.purposeId).toBeNull();
    expect(parsed.notes).toBeUndefined();
  });
});
