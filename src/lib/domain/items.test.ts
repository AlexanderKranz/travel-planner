import { describe, expect, it } from "vitest";
import golfItems from "@/lib/items/__fixtures__/items-golf.json";
import golfDoc from "@/lib/server/__fixtures__/plan-document-golf.json";
import cruiseDoc from "@/lib/server/__fixtures__/plan-document-cruise.json";
import { Plan } from "./plan";
import { TripItemInput } from "./items";
import { ShareLinkInput } from "./share";

describe("phase 5 contracts and fixtures", () => {
  it("golf items satisfy TripItemInput", () => {
    for (const i of golfItems) expect(TripItemInput.safeParse(i).success, i.title).toBe(true);
  });
  it("plan documents embed valid plans", () => {
    expect(Plan.safeParse(golfDoc.plan).success).toBe(true);
    expect(Plan.safeParse(cruiseDoc.plan).success).toBe(true);
    expect(cruiseDoc.items).toBeNull();
  });
  it("share input defaults notes off", () => {
    const r = ShareLinkInput.parse({ label: null, expiresInDays: 7, includeItems: true });
    expect(r.includeItemNotes).toBe(false);
    expect(ShareLinkInput.safeParse({ label: null, expiresInDays: 5, includeItems: true }).success).toBe(false);
  });
});

describe("item times", () => {
  const base = { category: "flight", title: "LH 1150 FRA → AGP", priceCents: null, persons: null, day: 1, ref: null, url: null, notes: null };
  it("are optional and default to null", () => {
    expect(TripItemInput.parse(base)).toMatchObject({ startTime: null, endTime: null });
  });
  it("accept HH:MM, an end before the start (crosses midnight) and a start alone", () => {
    expect(TripItemInput.safeParse({ ...base, startTime: "07:50", endTime: "10:40" }).success).toBe(true);
    expect(TripItemInput.safeParse({ ...base, startTime: "23:10", endTime: "01:20" }).success).toBe(true);
    expect(TripItemInput.safeParse({ ...base, startTime: "10:00" }).success).toBe(true);
  });
  it("reject bad formats and an end without a start", () => {
    for (const t of ["7:50", "24:00", "10:60", "10:00:00", ""]) {
      expect(TripItemInput.safeParse({ ...base, startTime: t }).success, t).toBe(false);
    }
    const r = TripItemInput.safeParse({ ...base, endTime: "10:40" });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["endTime"]);
  });
});
