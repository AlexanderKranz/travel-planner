import { describe, expect, it, vi } from "vitest";
import type { Plan } from "@/lib/domain/plan";
import de from "../../../messages/de.json";
import { makeT } from "@/lib/pdf/labels";
import { planGlance, type PlanGlancePlace } from "@/lib/server/plan-glance";
import { planGlanceTiles } from "./plan-glance";

vi.mock("server-only", () => ({}));

const plan = {
  header: { destination: "Edinburgh", lengthDays: 4, timing: { kind: "date", startDate: "2026-12-10", endDate: "2026-12-13" } },
  facts: {
    climate: {
      months: [{ month: 12, tMaxC: 7.2, tMinC: 2.8, wetDays: 14.6, sunshineHours: 1.4 }],
      period: { from: 1991, to: 2020 },
      fetchedAt: "2026-10-31T10:00:00.000Z",
    },
    daylight: {
      timezone: "Europe/London",
      days: [
        { date: "2026-12-10", sunrise: "08:30", dusk: "16:25" },
        { date: "2026-12-11", sunrise: "08:37", dusk: "16:24" },
        { date: "2026-12-12", sunrise: "08:38", dusk: "16:24" },
      ],
    },
  },
} as unknown as Pick<Plan, "header" | "facts">;

const place: PlanGlancePlace = { name: "Edinburgh", countryCode: "GB", lat: 55.95, lon: -3.19, timezone: "Europe/London" };
const t = makeT(de.pdf.glance);

describe("planGlance", () => {
  it("fills all tiles from the snapshot, the country dataset and suncalc", () => {
    const g = planGlance(plan, place, "2026-11-01");
    expect(g.climate).toMatchObject({ months: [12], tMaxC: 7.2 });
    expect(g.daylight).toMatchObject({ date: "2026-12-11", sunrise: "08:37", dusk: "16:24" });
    expect(g.daylight?.sunset).toMatch(/^15:\d\d$/);
    expect(g.country).toMatchObject({ code: "GB", drivingSide: "left", timezone: "Europe/London · UTC+00:00" });
  });

  it("never carries coordinates", () => {
    expect(JSON.stringify(planGlance(plan, place, "2026-11-01"))).not.toContain("55.95");
  });

  it("ignores a destination changed after the plan was made", () => {
    const g = planGlance(plan, { name: "Tokyo", countryCode: "JP", lat: 35.7, lon: 139.7, timezone: "Asia/Tokyo" }, "2026-11-01");
    expect(g.country).toBeNull();
    expect(g.daylight).toMatchObject({ sunrise: "08:37", sunset: null });
  });

  it("ignores a different place of the same name", () => {
    const g = planGlance(plan, { name: "Edinburgh", countryCode: "US", lat: 26.3, lon: -98.2, timezone: "America/Chicago" }, "2026-11-01");
    expect(g.country).toBeNull();
    expect(g.daylight?.sunset).toBeNull();
  });

  it("keeps the country tile of a plan without daylight facts", () => {
    const p = { header: plan.header, facts: {} } as typeof plan;
    expect(planGlance(p, place, "2026-11-01").country).toMatchObject({ code: "GB" });
  });

  it("shows both offsets when the clocks change during the trip", () => {
    const p = structuredClone(plan);
    (p.header.timing as { startDate: string }).startDate = "2026-03-26";
    p.header.lengthDays = 7;
    expect(planGlance(p, place, "2026-11-01").country?.timezone).toBe("Europe/London · UTC+00:00 / UTC+01:00");
  });

  it("reports polar night instead of an empty tile", () => {
    const p = structuredClone(plan);
    p.facts.daylight!.days = [{ date: "2026-12-21", sunrise: null, dusk: null }];
    expect(planGlance(p, { ...place, lat: 78.2, lon: 15.6 }, "2026-11-01").daylight?.polar).toBe("night");
  });

  it("has no tiles without facts", () => {
    const p = { header: plan.header, facts: {} } as typeof plan;
    expect(planGlanceTiles({ glance: planGlance(p, null, "2026-11-01") }, "de", t)).toEqual([]);
  });
});

describe("planGlanceTiles", () => {
  it("renders the four tiles with signed hours", () => {
    const tiles = planGlanceTiles(
      { glance: planGlance(plan, place, "2026-11-01"), timeDifference: { kind: "behind", hours: "1", home: "Hochheim", notes: [] } },
      "de",
      t,
    );
    expect(tiles.map((x) => x.key)).toEqual(["climate", "daylight", "country", "time"]);
    expect(tiles[0]).toMatchObject({ label: "Klima im Dezember", value: "7° / 3°" });
    expect(tiles[1].label).toContain("Tageslicht um den 11.");
    expect(tiles[1].value).toMatch(/^08:37–15:\d\d$/);
    expect(tiles[2]).toMatchObject({ value: "Vereinigtes Königreich", flag: "🇬🇧" });
    expect(tiles[2].chips.map((c) => c.text)).toContain("Linksverkehr");
    expect(tiles[3]).toMatchObject({ value: "−1 Std.", lines: ["gegenüber Hochheim"] });
  });

  it("uses the default home and keeps the range sign", () => {
    const tiles = planGlanceTiles({ timeDifference: { kind: "range", hours: "−6", to: "−5", home: null, notes: ["changes"] } }, "de", t);
    expect(tiles[0].value).toBe("−6 bis −5 Std.");
    expect(tiles[0].lines[0]).toBe("gegenüber Deutschland");
  });
});
