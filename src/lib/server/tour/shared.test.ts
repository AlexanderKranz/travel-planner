import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import type { Op, Reply } from "./test-db";

const h = vi.hoisted(() => ({
  ops: [] as Op[],
  reply: (() => ({})) as (op: Op) => Reply,
  rpc: vi.fn(async () => ({ error: null })),
  logEvent: vi.fn(),
}));
vi.mock("../supabase/admin", async () => {
  const { fakeDb } = await import("./test-db");
  return { createSupabaseAdminClient: () => ({ ...fakeDb("admin", h.ops, (o) => h.reply(o)), rpc: h.rpc }) };
});
vi.mock("../events", () => ({ logEvent: h.logEvent }));

import { TourInput } from "@/lib/domain/tour";
import { tourInputHash } from "@/lib/tour/hash";
import { newShareToken } from "../share-token";
import { getSharedTour } from "./shared";

const TOUR = "11111111-1111-4111-8111-111111111111";
const { token } = newShareToken();
const input = TourInput.parse({
  places: [
    { key: "osm:n1", name: "Stephansdom", lat: 48.2085, lon: 16.3731, source: "osm" },
    { key: "osm:n2", name: "Hofburg", lat: 48.2065, lon: 16.3655, source: "osm" },
  ],
});
const result = { v: 1, order: ["osm:n1", "osm:n2"], legs: [], totalMin: 30, fit: "none", sights: [], source: { ors: "2026-11-12T00:00:00Z" } };
let link: Record<string, unknown> | null;
let owner: Record<string, unknown> | null;
let tour: Record<string, unknown> | null;

beforeEach(() => {
  h.ops = [];
  h.rpc.mockClear();
  h.logEvent.mockClear();
  link = { id: "L1", owner_id: "owner", tour_id: TOUR, expires_at: null };
  owner = { disabled_at: null, locale: "de" };
  tour = {
    id: TOUR, owner_id: "owner", title: "Altstadt", input, trip_id: "trip", trip_day: 2, result,
    result_hash: tourInputHash(input), computed_at: "x", created_at: "c", updated_at: "u",
  };
  h.reply = (o) => {
    if (o.table === "share_links") return { data: link };
    if (o.table === "profiles") return { data: owner };
    if (o.table === "city_tours") return { data: tour };
    return {};
  };
});

describe("getSharedTour (public tour link, city-tour 9.3)", () => {
  it("returns the stored tour read-only, without owner or trip, counts the view", async () => {
    const res = await getSharedTour(token, "page");
    expect(res).toMatchObject({ linkId: "L1", locale: "de", tour: { id: TOUR, access: "read", ownerId: "", tripId: null, tripDay: null, title: "Altstadt" } });
    const tourRead = h.ops.find((o) => o.table === "city_tours")!;
    expect(tourRead.eqs).toEqual([["id", TOUR], ["owner_id", "owner"]]);
    expect(h.rpc).toHaveBeenCalledWith("share_link_touch", { p_id: "L1" });
    expect(h.logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "share.viewed", props: { linkId: "L1", via: "page", kind: "tour" } }));
  });

  it("answers null (one identical 404) for a trip link, an expired link, a disabled owner, a missing or uncomputed tour, a bad token", async () => {
    link = { id: "L1", owner_id: "owner", tour_id: null, expires_at: null };
    expect(await getSharedTour(token, "page")).toBeNull();
    link = { id: "L1", owner_id: "owner", tour_id: TOUR, expires_at: "2000-01-01T00:00:00Z" };
    expect(await getSharedTour(token, "page")).toBeNull();
    link = { id: "L1", owner_id: "owner", tour_id: TOUR, expires_at: null };
    owner = { disabled_at: "2026-11-01T00:00:00Z", locale: "de" };
    expect(await getSharedTour(token, "page")).toBeNull();
    owner = { disabled_at: null, locale: "de" };
    tour = null;
    expect(await getSharedTour(token, "page")).toBeNull();
    tour = { id: TOUR, owner_id: "owner", title: null, input, trip_id: null, trip_day: null, result: null, result_hash: null, computed_at: null, created_at: "c", updated_at: "u" };
    expect(await getSharedTour(token, "page")).toBeNull();
    expect(await getSharedTour("not-a-token", "page")).toBeNull();
    expect(h.rpc).not.toHaveBeenCalled();
  });
});
