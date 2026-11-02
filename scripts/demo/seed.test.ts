import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { Plan } from "@/lib/domain/plan";
import { SearchDrops, SuggestionCards } from "@/lib/domain/destination-search";
import { PurposeTags } from "@/lib/domain/plan";
import { purposeTagsHash } from "@/lib/plan/hash";
import {
  buildExampleItems,
  buildExamplePurposeTags,
  buildExampleSearch,
  buildExampleTrip,
  buildExampleVersion,
  EXAMPLE_GROUP,
  EXAMPLE_ITEMS,
  EXAMPLE_TRIP,
  type ExamplePlanFile,
  type RecordedSearchFile,
} from "./seed";

const example = JSON.parse(readFileSync(resolve(__dirname, "example-plan.json"), "utf8")) as ExamplePlanFile;
const search = JSON.parse(readFileSync(resolve(__dirname, "discover-golf.json"), "utf8")) as RecordedSearchFile;
const HHMM = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;
const ids = { ownerId: "00000000-0000-4000-8000-000000000001", tripId: "00000000-0000-4000-8000-000000000002" };

describe("demo example seed", () => {
  it("trip row satisfies the trips constraints (date xor months, length, airports)", () => {
    const t = buildExampleTrip({ ownerId: ids.ownerId, groupId: "g", purposeId: "p" });
    expect(t.owner_id).toBe(ids.ownerId);
    expect(t.start_date).toBe("2038-03-13");
    expect(t.months).toEqual([]); // trips_timing_exclusive
    expect(EXAMPLE_TRIP.origin_airports.join(",")).toMatch(/^[A-Z]{3}(,[A-Z]{3})*$/);
    expect(EXAMPLE_TRIP.length_days).toBe(example.plan.header.lengthDays);
    expect(EXAMPLE_TRIP.dest_country_code).toMatch(/^[A-Z]{2}$/);
  });

  it("group is free text only (no structure, no parse, no stored ages)", () => {
    expect(EXAMPLE_GROUP.description.length).toBeGreaterThan(10);
    expect(EXAMPLE_GROUP.description.length).toBeLessThanOrEqual(1000);
    expect(Object.keys(EXAMPLE_GROUP).sort()).toEqual(["description", "name", "notes", "trait_keys"]);
  });

  it("items satisfy the trip_items constraints and include a booked flight with times", () => {
    const rows = buildExampleItems(ids) as (typeof EXAMPLE_ITEMS[number] & { owner_id: string; trip_id: string })[];
    expect(rows).toHaveLength(EXAMPLE_ITEMS.length);
    for (const r of rows) {
      expect(r.owner_id).toBe(ids.ownerId);
      expect(r.trip_id).toBe(ids.tripId);
      expect(r.title.length).toBeGreaterThanOrEqual(1);
      expect(r.title.length).toBeLessThanOrEqual(120);
      if (r.price_cents !== null) expect(r.price_cents).toBeGreaterThanOrEqual(0);
      if (r.start_time) expect(r.start_time).toMatch(HHMM);
      if (r.end_time) {
        expect(r.end_time).toMatch(HHMM);
        expect(r.start_time).not.toBeNull(); // trip_items_end_needs_start
      }
      if (r.day !== null) expect(r.day).toBeLessThanOrEqual(EXAMPLE_TRIP.length_days);
    }
    const flight = rows.find((r) => r.category === "flight" && r.status === "booked");
    expect(flight?.start_time).toBe("13:00");
    expect(flight?.end_time).toBe("16:00");
  });

  it("version row is a valid generated plan re-pointed at the real rows, with no cost", () => {
    const basis = { tripUpdatedAt: "2026-11-01T10:00:00.000Z", groupUpdatedAt: "2026-11-01T10:00:01.000Z", purposeUpdatedAt: "2026-11-01T10:00:02.000Z" };
    const v = buildExampleVersion(example, { ownerId: ids.ownerId, planId: "plan-1" }, basis);
    expect(v.kind).toBe("generate");
    expect(v.cost_micro_usd).toBe(0);
    expect(v.input_hash).toMatch(/^[0-9a-f]{64}$/);
    const plan = Plan.parse(v.plan);
    expect(plan.header.basis).toEqual(basis);
    expect(plan.header.title).toBe(EXAMPLE_TRIP.title);
    expect(plan.days).toHaveLength(EXAMPLE_TRIP.length_days);
    expect(plan.header.timing).toEqual({ kind: "date", startDate: EXAMPLE_TRIP.start_date, endDate: "2038-03-17" });
    // the shared example file is not mutated
    expect(example.plan.header.basis.tripUpdatedAt).toBe("2026-10-28T08:00:00.000Z");
  });

  it("contains no email addresses or secrets", () => {
    const all = JSON.stringify([EXAMPLE_TRIP, EXAMPLE_GROUP, EXAMPLE_ITEMS, example, search]);
    expect(all).not.toMatch(/@[a-z0-9-]+\.[a-z]{2,}/i);
  });

  describe("recorded destination search", () => {
    const row = buildExampleSearch(search, { ownerId: ids.ownerId, purposeId: "p", groupId: "g" });

    it("still parses with the current card and drop schemas", () => {
      expect(SuggestionCards.safeParse(row.cards).success).toBe(true);
      expect(SearchDrops.safeParse(row.drops).success).toBe(true);
      expect((row.cards as unknown[]).length).toBeGreaterThanOrEqual(3);
    });

    it("is a finished, unlocked flight search for the demo golf purpose at no cost", () => {
      expect(row).toMatchObject({ owner_id: ids.ownerId, purpose_id: "p", group_id: "g", status: "done", busy_until: null, cost_micro_usd: 0 });
      expect(row).not.toHaveProperty("id");
      expect(row).not.toHaveProperty("recorded_at");
      expect(row).not.toHaveProperty("purpose");
      expect(row.purpose_name).toBe("Golftrip");
      expect(row.travel_mode).toBe("flight");
    });

    it("carries valid tags whose hash belongs to the recorded purpose", () => {
      const p = search.purpose;
      expect(PurposeTags.safeParse(p.parsed_tags).success).toBe(true);
      expect(purposeTagsHash({ text: p.text, constraints: p.constraints, guided: p.guided } as Parameters<typeof purposeTagsHash>[0])).toBe(p.parsed_hash);
    });

    it("gives the tags only to an unchanged purpose", () => {
      const p = search.purpose;
      const seeded = { name: p.name, text: p.text, constraints: [...p.constraints], guided: { ...p.guided } };
      expect(buildExamplePurposeTags(search, seeded)).toMatchObject({ parsed_hash: p.parsed_hash, parsed_at: search.recorded_at });
      expect(buildExamplePurposeTags(search, { ...seeded, text: `${p.text} Edited.` })).toBeNull();
    });
  });
});
