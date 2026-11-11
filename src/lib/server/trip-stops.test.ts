import { describe, expect, it, vi } from "vitest";
import type { Trip } from "@/lib/domain/trip";
import { resolveTripStops } from "./trip-stops";

const base = { lengthDays: 5 } as Trip;

describe("resolveTripStops [D10]", () => {
  it("confirmed stops win and derivation is not even attempted", async () => {
    const derive = vi.fn();
    const got = await resolveTripStops({ ...base, notes: "x", stops: [{ day: 1, place: "Hafen" }] }, derive);
    expect(got).toEqual([{ day: 1, place: "Hafen" }]);
    expect(derive).not.toHaveBeenCalled();
  });

  it("derives from the notes when nothing is confirmed", async () => {
    const derive = vi.fn(async () => ({ notes: "Tag 1 Hafen", stops: [{ day: 1, place: "Hafen" }] }));
    expect(await resolveTripStops({ ...base, notes: "Tag 1 Hafen" }, derive)).toEqual([{ day: 1, place: "Hafen" }]);
    expect(derive).toHaveBeenCalledOnce();
  });

  it("does not derive without notes", async () => {
    const derive = vi.fn();
    expect(await resolveTripStops({ ...base }, derive)).toEqual([]);
    expect(derive).not.toHaveBeenCalled();
  });

  it("ignores a result for other notes, a null result and a failing derivation", async () => {
    const stale = async () => ({ notes: "alt", stops: [{ day: 1, place: "Hafen" }] });
    expect(await resolveTripStops({ ...base, notes: "neu" }, stale)).toEqual([]);
    expect(await resolveTripStops({ ...base, notes: "neu" }, async () => null)).toEqual([]);
    expect(await resolveTripStops({ ...base, notes: "neu" }, async () => { throw new Error("boom"); })).toEqual([]);
  });

  it("the default seam derives nothing yet", async () => {
    expect(await resolveTripStops({ ...base, notes: "Tag 1 Hafen" })).toEqual([]);
  });
});
