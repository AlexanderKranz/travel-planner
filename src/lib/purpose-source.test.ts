import { describe, expect, it } from "vitest";
import { oneOffLabel } from "@/lib/discover/one-off";
import type { TripPurpose } from "@/lib/domain/purpose";
import { isOneOffPurpose, tripPurpose } from "./purpose-source";

const TAGS = { v: 2 as const, interests: ["golf" as const], custom: [], hard: [], soft: [], summary: "Golf" };
const trip = { ownerId: "o1", access: "write" as const, purposeId: null, purposeText: undefined, purposeTags: undefined, updatedAt: "2026-11-01T10:00:00Z" };
const saved = { id: "p1", name: "Saved", guided: {}, constraints: [], tags: null, ownerId: "o1", access: "owner", usable: true, createdAt: "c", updatedAt: "u" } as TripPurpose;

describe("tripPurpose", () => {
  it("the saved purpose wins, even next to a (stale) text", () => {
    expect(tripPurpose({ ...trip, purposeId: "p1", purposeText: "x" }, saved)).toBe(saved);
  });
  it("a saved id whose purpose vanished is none, not the text", () => {
    expect(tripPurpose({ ...trip, purposeId: "p1" }, null)).toBeNull();
  });
  it("nothing at all is null", () => {
    expect(tripPurpose(trip, null)).toBeNull();
  });
  it("the one-off text becomes a transient, unusable purpose carrying owner, access and the trip's updatedAt", () => {
    const text = "Golf mit einem Freund, flache Plätze, gutes Essen am Abend und ein bisschen Strand";
    const p = tripPurpose({ ...trip, purposeText: text, purposeTags: TAGS }, null)!;
    expect(p).toMatchObject({
      id: "",
      name: oneOffLabel(text),
      text,
      guided: {},
      constraints: [],
      tags: TAGS,
      ownerId: "o1",
      access: "write",
      usable: false,
      createdAt: trip.updatedAt,
      updatedAt: trip.updatedAt,
    });
    expect(isOneOffPurpose(p)).toBe(true);
    expect(isOneOffPurpose(saved)).toBe(false);
  });
  it("without tags the purpose has tags null (the raw-text fallback applies)", () => {
    expect(tripPurpose({ ...trip, purposeText: "Golf" }, null)!.tags).toBeNull();
  });
});
