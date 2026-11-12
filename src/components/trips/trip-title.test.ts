import { describe, expect, it } from "vitest";
import { tripTitle } from "./trip-title";

describe("tripTitle", () => {
  const destination = { kind: "freetext" as const, name: "Passau" };
  it("is the own title, else only the destination name (no dates or length, Alex 2026-11-12)", () => {
    expect(tripTitle({ title: "Advent auf der Donau", destination } as never)).toBe("Advent auf der Donau");
    expect(tripTitle({ title: undefined, destination } as never)).toBe("Passau");
  });
});
