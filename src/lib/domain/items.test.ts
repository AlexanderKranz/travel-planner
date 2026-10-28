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
