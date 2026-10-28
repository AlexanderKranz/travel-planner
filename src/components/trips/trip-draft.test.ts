import { describe, expect, it } from "vitest";
import { TripInput } from "@/lib/domain";
import { draftFromTrip, draftProblems, draftToInput, emptyTripDraft } from "./trip-draft";

describe("trip draft", () => {
  it("needs destination only; length defaults", () => {
    expect(draftProblems(emptyTripDraft())).toEqual(["destination"]);
  });

  it("builds a minimal valid free text input", () => {
    const draft = emptyTripDraft();
    draft.destination = { mode: "freetext", name: " Donau ", countryCode: "" };
    expect(draftProblems(draft)).toEqual([]);
    const parsed = TripInput.parse(draftToInput(draft));
    expect(parsed.destination).toEqual({ kind: "freetext", name: "Donau" });
    expect(parsed.timing).toEqual({ kind: "none" });
  });

  it("sends renamed geo destination with radius and months", () => {
    const draft = emptyTripDraft();
    draft.destination = {
      mode: "geo", geoKind: "region", geoId: 2513416, placeName: "Marbella",
      placeLabel: "Marbella", name: "Costa del Sol", radiusKm: 40,
    };
    draft.timing = { mode: "months", startDate: "", months: [4, 3] };
    const parsed = TripInput.parse(draftToInput(draft));
    expect(parsed.destination).toMatchObject({ kind: "region", name: "Costa del Sol", radiusKm: 40 });
    expect(parsed.timing).toEqual({ kind: "months", months: [3, 4] });
  });

  it("omits name when unchanged and ignores origin override without flights", () => {
    const draft = emptyTripDraft(false);
    draft.destination = {
      mode: "geo", geoKind: "city", geoId: 1, placeName: "Passau", placeLabel: "Passau", name: "Passau", radiusKm: null,
    };
    draft.useHomeAirports = false;
    draft.originAirports = ["FRA"];
    const input = draftToInput(draft);
    expect(input.destination).toEqual({ kind: "city", geoId: 1 });
    expect(input.originAirports).toEqual([]);
  });

  it("flags incomplete timing", () => {
    const draft = emptyTripDraft();
    draft.destination = { mode: "freetext", name: "x", countryCode: "" };
    draft.timing.mode = "date";
    expect(draftProblems(draft)).toEqual(["timing"]);
  });

  it("round-trips a stored trip", () => {
    const draft = draftFromTrip({
      id: "1", destination: { kind: "city", name: "Passau", placeName: "Passau", geoId: 5, countryCode: "DE", admin1: "Bayern", lat: 1, lon: 1, timezone: "Europe/Berlin", radiusKm: 15 },
      lengthDays: 7, timing: { kind: "months", months: [12] }, groupId: null, purposeId: null,
      wantsFlights: false, originAirports: [], createdAt: "", updatedAt: "",
    });
    expect(draftToInput(draft)).toMatchObject({ destination: { kind: "city", geoId: 5 }, timing: { kind: "months", months: [12] } });
  });
});
