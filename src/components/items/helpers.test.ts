import { describe, expect, it } from "vitest";
import golf from "@/lib/items/__fixtures__/items-golf.json";
import type { SharedItem } from "@/lib/domain/items";
import { centsToInput, dayDate, flightPrefill, groupItems, hostOf, isRange, placePrefill, priceLine } from "./helpers";

const items = golf as unknown as SharedItem[];

describe("groupItems", () => {
  const { groups, rejected } = groupItems(items);
  it("splits rejected items off", () => {
    expect(rejected.map((i) => i.status)).toEqual(["rejected"]);
    expect(groups.flatMap((g) => g.items).some((i) => i.status === "rejected")).toBe(false);
  });
  it("sorts days ascending with no-day last", () => {
    const days = groups.map((g) => g.day);
    expect(days.at(-1)).toBeNull();
    const nums = days.filter((d): d is number => d !== null);
    expect(nums).toEqual([...nums].sort((a, b) => a - b));
  });
});

describe("hostOf", () => {
  it("strips www and rejects non-http", () => {
    expect(hostOf("https://www.example.com/a?b=1")).toBe("example.com");
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(hostOf(null)).toBeNull();
    expect(hostOf("nonsense")).toBeNull();
  });
});

describe("dayDate", () => {
  it("adds days across month ends", () => {
    expect(dayDate("2027-02-27", 1)).toBe("2027-02-27");
    expect(dayDate("2027-02-27", 3)).toBe("2027-03-01");
    expect(dayDate(null, 2)).toBeNull();
  });
});

describe("priceLine", () => {
  const base = { priceCents: 45900, priceBasis: "total" as const, persons: 2 };
  it("shows total first with per-person and head count", () => {
    expect(priceLine(base, null)).toEqual({
      primary: { kind: "total", cents: 45900 },
      secondary: { kind: "perPerson", cents: 22950 },
      sharedBy: 2,
    });
  });
  it("shows per person first and derives the total from the party", () => {
    const l = priceLine({ priceCents: 9500, priceBasis: "per_person", persons: null }, 2);
    expect(l?.secondary).toEqual({ kind: "total", cents: 19000 });
    expect(l?.sharedBy).toBeNull();
  });
  it("has no secondary amount without a head count, and none without a price", () => {
    expect(priceLine({ priceCents: 1000, priceBasis: "total", persons: null }, null)?.secondary).toBeNull();
    expect(priceLine({ priceCents: null, priceBasis: "total", persons: null }, 2)).toBeNull();
  });
});

describe("prefills", () => {
  it("flight legs land on day 1 or the last day", () => {
    const leg = { dir: "out" as const, number: "LH 1148", from: "FRA", to: "AGP", dep: "07:50", arr: "10:40", date: "2038-03-13" };
    expect(flightPrefill(leg, 5, null)).toEqual({
      title: "LH 1148 FRA → AGP",
      category: "flight",
      day: 1,
      ref: null,
      startTime: "07:50",
      endTime: "10:40",
    });
    expect(flightPrefill({ ...leg, dir: "back", number: "LH 1149", from: "AGP", to: "FRA" }, 5, null).day).toBe(5);
  });
  it("places become activity options on their day", () => {
    expect(placePrefill({ name: "Real Club Valderrama" }, "way/1", 3)).toEqual({
      title: "Real Club Valderrama",
      category: "activity",
      day: 3,
      ref: "way/1",
    });
  });
});

describe("misc", () => {
  it("formats cents for the input", () => {
    expect(centsToInput(43264, "de")).toBe("432,64");
    expect(centsToInput(45900, "en")).toBe("459");
    expect(centsToInput(null, "de")).toBe("");
  });
  it("detects ranges", () => {
    expect(isRange({ minCents: 1, maxCents: 2 })).toBe(true);
    expect(isRange({ minCents: 2, maxCents: 2 })).toBe(false);
  });
});
