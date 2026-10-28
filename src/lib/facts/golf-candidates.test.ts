import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
import { parseElements } from "@/lib/integrations/overpass";
import { rankCandidates } from "./places";

const fixture = JSON.parse(
  readFileSync(resolve(__dirname, "../integrations/__fixtures__/overpass/golf-marbella-40km.json"), "utf8"),
);
const marbella = { lat: 36.51543, lon: -4.88583 };
const filters = [`["leisure"="golf_course"]`];

// Not golf courses a visitor can play: driving ranges, lessons, clubhouse points, academies, pitch & putt.
const NOT_A_COURSE = /driving range|\brange\b|lessons|clubhouse|academy|academia|pitch ?(&|and)? ?putt/i;

describe("golf candidates (fixture: Marbella 40 km)", () => {
  const all = rankCandidates(parseElements(fixture), filters, marbella);

  it("fixture really contains non-course entries (documents the data-quality problem)", () => {
    expect(all.some((c) => NOT_A_COURSE.test(c.name))).toBe(true);
  });
  it("OSM gives no discriminating tag in this data (a tag-only filter cannot work)", () => {
    const raw = parseElements(fixture).filter((e) => NOT_A_COURSE.test(e.tags.name ?? ""));
    expect(raw.length).toBeGreaterThan(0);
    expect(raw.every((e) => e.tags.golf === undefined)).toBe(true);
  });
  // Suggested deterministic filter, in rankCandidates for interest golf (or a per-interest `exclude` in INTEREST_SOURCES):
  //  1. drop names matching /driving range|\brange\b|lessons|clubhouse|academy|pitch ?(&|and)? ?putt|par ?3/i
  //  2. drop nodes (type=node) when a way/relation golf_course exists (nodes are POIs, not course areas)
  //  3. query-side: add `["golf"!~"^(driving_range|practice)$"]` where tagged
  it.fails("KNOWN DEFECT: result contains driving ranges / clubhouse / lesson nodes among the top 25", () => {
    expect(all.filter((c) => NOT_A_COURSE.test(c.name)).map((c) => c.name)).toEqual([]);
  });
  it("the list is capped at 25, unique by osm id", () => {
    expect(all.length).toBeLessThanOrEqual(25);
    expect(new Set(all.map((c) => `${c.osmType}/${c.osmId}`)).size).toBe(all.length);
  });
});
