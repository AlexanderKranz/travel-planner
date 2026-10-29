import { describe, expect, it } from "vitest";
import type { SharedItem } from "@/lib/domain/items";
import type { PlanDay } from "@/lib/domain/plan";
import {
  dropOverlaps,
  fixedItemsOf,
  fixedSlots,
  flightPrefill,
  itemForLeg,
  itemsChangedSince,
  legDay,
  mergeDayRows,
  overlapsSlot,
  timeRange,
  titleHasFlight,
} from "./fixed-items";

const item = (o: Partial<SharedItem>): SharedItem => ({
  id: "i",
  category: "activity",
  title: "x",
  status: "booked",
  priceCents: null,
  priceBasis: "total",
  persons: null,
  currency: "EUR",
  day: 1,
  ref: null,
  url: null,
  notes: null,
  startTime: null,
  endTime: null,
  ...o,
});

const flight = item({ id: "f", category: "flight", title: "LH 1150 FRA → AGP", day: 1, startTime: "07:50", endTime: "10:40" });
const tee = item({ id: "t", category: "activity", title: "Tee time Valderrama", status: "planned", day: 2, startTime: "09:30" });

describe("fixedItemsOf", () => {
  it("keeps booked/planned items with a day in range and a start time, sorted", () => {
    const list = [
      tee,
      flight,
      item({ id: "o", status: "option", startTime: "12:00" }),
      item({ id: "r", status: "rejected", startTime: "12:00" }),
      item({ id: "n", day: null, startTime: "12:00" }),
      item({ id: "s", startTime: null }),
      item({ id: "d", day: 9, startTime: "12:00" }),
    ];
    expect(fixedItemsOf(list, 5).map((f) => f.id)).toEqual(["f", "t"]);
    expect(fixedItemsOf([flight], 5)[0]).toEqual({ id: "f", day: 1, from: "07:50", to: "10:40", category: "flight", title: "LH 1150 FRA → AGP", status: "booked" });
  });
  it("tolerates items without time fields (older rows/fixtures)", () => {
    const old = { ...item({}), startTime: undefined, endTime: undefined } as unknown as SharedItem;
    expect(fixedItemsOf([old], 5)).toEqual([]);
  });
});

describe("fixedSlots (LLM input)", () => {
  it("is compact: no ids or status; flights without title (no flight numbers in the prompt)", () => {
    expect(fixedSlots(fixedItemsOf([flight, tee], 5))).toEqual([
      { day: 1, from: "07:50", to: "10:40", cat: "flight" },
      { day: 2, from: "09:30", cat: "activity", title: "Tee time Valderrama" },
    ]);
  });
  it("is undefined without fixed items", () => {
    expect(fixedSlots([])).toBeUndefined();
  });
});

describe("overlap", () => {
  it("treats an activity with only at as a point and a slot without to as a point", () => {
    expect(overlapsSlot({ at: "08:00" }, { from: "07:50", to: "10:40" })).toBe(true);
    expect(overlapsSlot({ at: "10:40" }, { from: "07:50", to: "10:40" })).toBe(false);
    expect(overlapsSlot({ at: "06:00", until: "08:00" }, { from: "07:50", to: "10:40" })).toBe(true);
    expect(overlapsSlot({ at: "09:30" }, { from: "09:30" })).toBe(true);
    expect(overlapsSlot({ at: "09:00", until: "09:30" }, { from: "09:30" })).toBe(false);
    expect(overlapsSlot({}, { from: "09:30" })).toBe(false);
  });
  it("runs a slot that ends before it starts to midnight", () => {
    expect(overlapsSlot({ at: "23:30" }, { from: "23:10", to: "01:20" })).toBe(true);
    expect(overlapsSlot({ at: "00:30" }, { from: "23:10", to: "01:20" })).toBe(false);
  });
  it("dropOverlaps removes overlapping timed acts of that day only", () => {
    const day: PlanDay = {
      n: 1,
      date: null,
      title: "Arrival",
      stops: [{ place: "Marbella", acts: [{ kind: "travel", text: "Arrival" }, { at: "09:00", kind: "sport", text: "Golf" }, { at: "13:00", kind: "sport", text: "Golf" }] }],
    };
    const r = dropOverlaps(day, [{ day: 1, from: "07:50", to: "10:40" }, { day: 2, from: "13:00" }]);
    expect(r.dropped).toBe(1);
    expect(r.day.stops[0].acts.map((a) => a.at ?? "-")).toEqual(["-", "13:00"]);
    expect(dropOverlaps(day, [{ day: 2, from: "09:00" }]).day).toBe(day);
  });
});

describe("mergeDayRows", () => {
  const day: PlanDay = {
    n: 1,
    date: "2038-03-13",
    title: "Arrival",
    stops: [
      { place: "Málaga", acts: [{ kind: "travel", text: "Arrival and transfer" }, { at: "12:30", kind: "sport", text: "Golf" }] },
      { place: "Marbella", acts: [{ at: "19:00", kind: "food", text: "Dinner" }] },
    ],
  };
  const rows = (fixed: ReturnType<typeof fixedItemsOf>) =>
    mergeDayRows(day, fixed).map((s) => s.rows.map((r) => (r.kind === "fixed" ? `F:${r.item.id}` : r.act.text)));

  it("puts a morning flight before the untimed arrival act that leads into the first timed act", () => {
    expect(rows(fixedItemsOf([flight], 3))).toEqual([["F:f", "Arrival and transfer", "Golf"], ["Dinner"]]);
  });
  it("places items between activities in time order, across stops", () => {
    const checkIn = item({ id: "c", category: "stay", title: "Check-in", startTime: "16:00" });
    const late = item({ id: "l", category: "food", title: "Bar", startTime: "22:00" });
    expect(rows(fixedItemsOf([checkIn, late], 3))).toEqual([["Arrival and transfer", "Golf"], ["F:c", "Dinner", "F:l"]]);
  });
  it("ignores items of other days", () => {
    expect(rows(fixedItemsOf([tee], 3))).toEqual([["Arrival and transfer", "Golf"], ["Dinner"]]);
  });
});

describe("flight list → item", () => {
  const leg = { dir: "out" as const, number: "LH 1150", from: "FRA", to: "AGP", dep: "07:50", arr: "10:40", date: "2038-03-13" };
  const back = { ...leg, dir: "back" as const, number: "LH 1151", from: "AGP", to: "FRA", dep: "11:35", arr: "14:25", date: "2038-03-17" };
  it("prefills category, title, trip day and times", () => {
    expect(flightPrefill(leg, 5, "2038-03-13")).toEqual({ title: "LH 1150 FRA → AGP", category: "flight", day: 1, ref: null, startTime: "07:50", endTime: "10:40" });
    expect(flightPrefill(back, 5, "2038-03-13").day).toBe(5);
  });
  it("uses the date for dated trips and the direction otherwise", () => {
    expect(legDay({ dir: "out", date: "2038-03-14" }, 5, "2038-03-13")).toBe(2);
    expect(legDay({ dir: "back", date: "2038-06-01" }, 5, null)).toBe(5);
    expect(legDay({ dir: "back", date: "2038-06-01" }, 5, "2038-03-13")).toBe(5); // out of range → direction
  });
  it("matches flight numbers with or without space, not longer numbers", () => {
    expect(titleHasFlight("LH1150 Frankfurt", "LH 1150")).toBe(true);
    expect(titleHasFlight("Flug lh 1150", "LH 1150")).toBe(true);
    expect(titleHasFlight("LH 11500", "LH 1150")).toBe(false);
    expect(titleHasFlight("XLH 1150", "LH 1150")).toBe(false);
  });
  it("finds the item that holds a leg (same number + day, not rejected)", () => {
    expect(itemForLeg(leg, [flight], 5, "2038-03-13")?.id).toBe("f");
    expect(itemForLeg(leg, [{ ...flight, day: 2 }], 5, "2038-03-13")).toBeUndefined();
    expect(itemForLeg(leg, [{ ...flight, status: "rejected" }], 5, "2038-03-13")).toBeUndefined();
    expect(itemForLeg(leg, [{ ...flight, status: "option" }], 5, "2038-03-13")?.status).toBe("option");
    expect(itemForLeg(back, [flight], 5, "2038-03-13")).toBeUndefined();
  });
});

describe("helpers", () => {
  it("timeRange", () => {
    expect(timeRange("07:50", "10:40")).toBe("07:50–10:40");
    expect(timeRange("23:10", "01:20")).toBe("23:10–01:20 +1");
    expect(timeRange("10:00", null)).toBe("10:00");
    expect(timeRange(null)).toBe("");
  });
  it("itemsChangedSince only counts timed items changed after the version", () => {
    const v = "2026-10-28T10:00:00Z";
    expect(itemsChangedSince([{ day: 1, startTime: "07:50", updatedAt: "2026-10-28T11:00:00Z" }], v)).toBe(true);
    expect(itemsChangedSince([{ day: 1, startTime: "07:50", updatedAt: "2026-10-28T09:00:00Z" }], v)).toBe(false);
    expect(itemsChangedSince([{ day: null, startTime: "07:50", updatedAt: "2026-10-28T11:00:00Z" }], v)).toBe(false);
    expect(itemsChangedSince([{ day: 1, startTime: null, updatedAt: "2026-10-28T11:00:00Z" }], v)).toBe(false);
  });
});
