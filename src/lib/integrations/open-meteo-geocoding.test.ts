import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("server-only", () => ({}));
const state = vi.hoisted(() => ({ fetch: ((u: string): Promise<unknown> => Promise.resolve(u)), urls: [] as string[] }));
vi.mock("./http", async (orig) => {
  const real = await orig<typeof import("./http")>();
  return { ...real, fetchJson: (u: string) => { state.urls.push(u); return state.fetch(u); } };
});
// cached(): run the fetcher directly, rethrow nothing (mirrors the real contract: ok:false on throw).
vi.mock("@/lib/server/api-cache", () => ({
  cacheKey: (e: string, v: number, p: Record<string, string | number>) => `${e}:v${v}:${JSON.stringify(p)}`,
  cached: async (o: { fetcher: () => Promise<{ data: unknown }> }) => {
    try {
      return { ok: true, data: (await o.fetcher()).data, fetchedAt: "x", stale: false, cache: "miss" };
    } catch {
      return { ok: false, error: "provider_error" };
    }
  },
}));

import { HttpError } from "./http";
import { getPlaceById, searchPlaces } from "./open-meteo-geocoding";

const fx = (p: string) => JSON.parse(readFileSync(join(__dirname, "__fixtures__", p), "utf8"));
beforeEach(() => { state.urls = []; });

describe("geocoding client", () => {
  it("getPlaceById resolves Passau", async () => {
    state.fetch = async () => ({ status: 200, latencyMs: 5, body: fx("open-meteo/geocoding-get-2855328.json") });
    expect(await getPlaceById(2855328, "de")).toMatchObject({ geoId: 2855328, name: "Passau", timezone: "Europe/Berlin" });
    expect(state.urls[0]).toBe("https://geocoding-api.open-meteo.com/v1/get?id=2855328&language=de");
  });
  it("returns null for an unknown id (HTTP 400) and throws on provider errors", async () => {
    state.fetch = async () => { throw new HttpError(400); };
    expect(await getPlaceById(1, "en")).toBeNull();
    state.fetch = async () => { throw new HttpError(503); };
    await expect(getPlaceById(1, "en")).rejects.toThrow();
  });
  it("searchPlaces normalizes the query and builds the documented URL", async () => {
    state.fetch = async () => ({ status: 200, latencyMs: 5, body: fx("open-meteo/geocoding-search-passau-de.json") });
    const r = await searchPlaces("  Passau ", "de");
    expect(r[0].geoId).toBe(2855328);
    expect(state.urls[0]).toBe("https://geocoding-api.open-meteo.com/v1/search?name=passau&count=8&language=de&format=json");
  });
});
