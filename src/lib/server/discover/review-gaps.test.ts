import { describe, expect, it, vi } from "vitest";
import type { GeoPlace } from "@/lib/domain/geo";
import type { CachedResult } from "../api-cache";
import { rowToSearch, type SearchRow } from "./store";
import { verifyIdeas, type VerifyDeps } from "./verify";

vi.mock("server-only", () => ({}));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

const ok = <T,>(data: T): CachedResult<T> => ({ ok: true, data, fetchedAt: "2026-11-01T10:00:00.000Z", stale: false, cache: "miss" });
const rome: GeoPlace = { geoId: 3169070, name: "Rome", featureCode: "PPLC", countryCode: "IT", admin1: "Latium", lat: 41.89, lon: 12.48, timezone: "Europe/Rome", population: 2800000, suggestedKind: "city" };
const deps: VerifyDeps = {
  geocode: async () => ok([rome]),
  climate: async () => ok([]),
  pois: async () => null,
  driveRoute: async () => ({ ok: false, error: "provider_error" }),
  placeById: async () => null,
  now: () => 0,
};
const run = (name: string, reason: string) =>
  verifyIdeas({ ideas: [{ name, anchor: "Rome", cc: "IT", reason }], round: 1, lang: "en", userId: "u", today: "2026-11-01", months: [], origins: [], maxHours: null, interests: [], existing: [] }, deps);

describe("card name is model text too", () => {
  // `reason` goes through cleanReason; `name` does not, but it is the card title and becomes the trip's destination name.
  it("a name stating a flight, a price or a time is not shown as the title", async () => {
    const out = await run("Rom: Direktflug ab 49 € in 90 Minuten", "Schöne Altstadt");
    expect(out.cards[0].name).not.toMatch(/Direktflug|€|Minuten/);
    expect(out.cards[0].name).toBe("Rome"); // the verified place name
    expect(out.cards[0].kind).toBe("city");
  });
  it("a normal name passes", async () => {
    expect((await run("Rom", "Schöne Altstadt")).cards[0].name).toBe("Rom");
  });
});

const row = (over: Partial<SearchRow>): SearchRow => ({
  id: "i", purpose_id: null, group_id: null, purpose_name: "P", locale: "de", months: [], origins: [], max_flight_hours: null, radius_km: null,
  travel_mode: "flight", max_drive_hours: null, home_name: null, home_lat: null, home_lon: null,
  input_hash: "a".repeat(64), input: { v: 1 }, status: "done", busy_until: null, rounds: 1, cards: [], drops: {}, error_code: null, model: null,
  cost_micro_usd: 0, created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", ...over,
});

describe("a running row left behind by a killed function", () => {
  const card = { id: "g1", round: 1, name: "Passau", reason: null, kind: "city", geoId: 1, placeName: "Passau", countryCode: "DE", admin1: null, place: { source: "geonames", fetchedAt: "x", stale: false }, flight: null, nearAirport: false, climate: null, pois: [] };
  it("reads as failed once the lock has run out (never running forever)", () => {
    const s = rowToSearch(row({ status: "running", busy_until: "2020-01-01T00:00:00Z" }));
    expect(s.status).toBe("failed");
  });
  it("still running while the lock holds", () => {
    expect(rowToSearch(row({ status: "running", busy_until: new Date(Date.now() + 60_000).toISOString() })).status).toBe("running");
  });
  it("a killed round 2 keeps the round-1 list usable (done, cards kept, no new call)", () => {
    const s = rowToSearch(row({ status: "running", rounds: 1, cards: [card] as never, busy_until: "2020-01-01T00:00:00Z" }));
    expect(s.status).toBe("done");
  });
});
