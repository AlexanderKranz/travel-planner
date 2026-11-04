import { describe, expect, it } from "vitest";
import { draftToInput } from "@/components/trips/trip-draft";
import { TripInput } from "@/lib/domain/trip";
import { buildTripDraft } from "./prefill";

const search = { id: "11111111-1111-4111-8111-111111111111", months: [3], origins: ["FRA"], purposeId: "22222222-2222-4222-8222-222222222222", groupId: null };
const card = { kind: "region" as const, geoId: 2513918, placeName: "Marbella", name: "Costa del Sol", admin1: "Andalusia" };

describe("buildTripDraft: one-off purpose (spec 13.5)", () => {
  const reasonCard = { ...card, reason: "Flache Plätze und mildes Klima" } as typeof card;
  it("an unsaved one-off puts its own text into notes and leaves the purpose empty; never the reason", () => {
    const d = buildTripDraft({ ...search, purposeId: null, purposeText: "Golf mit einem Freund" }, reasonCard, ["FRA"]);
    expect(d.purposeId).toBe("");
    expect(d.notes).toBe("Golf mit einem Freund");
    expect(JSON.stringify(d)).not.toContain("mildes Klima");
  });
  it("a saved or linked purpose keeps notes empty, also when the text is still on the row", () => {
    expect(buildTripDraft({ ...search, purposeText: null }, reasonCard, []).notes).toBe("");
    const linked = buildTripDraft({ ...search, purposeText: "Golf mit einem Freund" }, reasonCard, []);
    expect(linked.purposeId).toBe(search.purposeId);
    expect(linked.notes).toBe("");
  });
  it("a deleted purpose without text has empty notes", () => {
    expect(buildTripDraft({ ...search, purposeId: null, purposeText: null }, reasonCard, []).notes).toBe("");
  });
  it("the notes pass TripInput validation", () => {
    const d = buildTripDraft({ ...search, purposeId: null, purposeText: "Golf mit einem Freund" }, card, ["FRA"]);
    expect(TripInput.parse(draftToInput(d)).notes).toBe("Golf mit einem Freund");
  });
});
