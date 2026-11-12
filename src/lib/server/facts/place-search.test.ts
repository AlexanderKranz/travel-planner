import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  store: new Map<string, unknown>(),
  calls: [] as Record<string, unknown>[],
  outcomes: [] as Record<string, unknown>[],
  quota: 0,
  quotaOk: true,
  fetchJson: vi.fn(),
}));
vi.mock("../api-cache", async (orig) => {
  const m = await orig<typeof import("../api-cache")>();
  return {
    ...m,
    cached: async (o: { key: string; schema: { parse: (v: unknown) => unknown }; fetcher: () => Promise<{ data: unknown }> }) => {
      h.calls.push(o);
      if (h.store.has(o.key)) return { ok: true, data: h.store.get(o.key), fetchedAt: "f0", stale: false, cache: "hit" };
      try {
        const out = await o.fetcher();
        h.outcomes.push(out);
        const data = o.schema.parse(out.data);
        h.store.set(o.key, data);
        return { ok: true, data, fetchedAt: "f1", stale: false, cache: "miss" };
      } catch {
        return { ok: false, error: "provider_error" };
      }
    },
  };
});
vi.mock("./geoapify-quota", () => ({
  assertGeoapifyQuota: async () => {
    h.quota++;
    if (!h.quotaOk) throw Object.assign(new Error("cap"), { name: "QuotaGuardError" });
  },
}));
vi.mock("@/lib/integrations/http", async (orig) => ({ ...(await orig<typeof import("@/lib/integrations/http")>()), fetchJson: h.fetchJson }));

import { HttpError } from "@/lib/integrations/http";
import { autocompleteKey, autocompletePlaces, placeDetails, placeDetailsKey } from "./place-search";

const fx = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "../../integrations/__fixtures__/geoapify-autocomplete", `${name}.json`), "utf8"));
const wien = { lat: 48.2085, lon: 16.3731 };
const ctx = { userId: "u1" };

beforeEach(() => {
  h.store.clear();
  h.calls.length = 0;
  h.outcomes.length = 0;
  h.quota = 0;
  h.quotaOk = true;
  h.fetchJson.mockReset();
  vi.stubEnv("GEOAPIFY_API_KEY", "gk");
});
afterEach(() => vi.unstubAllEnvs());

describe("autocompletePlaces", () => {
  it("key: normalized query + 2-decimal cell + lang (nearby centres and spelling variants share it)", () => {
    const k = autocompleteKey("Stephansdom", wien, "de");
    expect(k).toBe("autocomplete:v1:cell=48.21,16.37;lang=de;q=stephansdom");
    expect(autocompleteKey("  STEPHANSDOM ", { lat: 48.2101, lon: 16.3699 }, "de")).toBe(k);
    expect(autocompleteKey("Stephansdom", wien, "en")).not.toBe(k);
  });

  it("one credit through the Geoapify guard, cached 30 days as geoapify/autocomplete; a repeat is a hit", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, latencyMs: 570, body: fx("autocomplete-stephansdom-wien-de") });
    const r = await autocompletePlaces({ q: "Stephansdom", ...wien, lang: "de" }, ctx);
    expect(r).toMatchObject({ ok: true, fetchedAt: "f1" });
    expect(r.ok && r.suggestions.map((s) => s.name)).toEqual(["Stephansdom", "Stephansdom Krypta", "Stephansdom", "Hotel SOFITEL VIENNA STEPHANSDOM"]);
    expect(h.calls[0]).toMatchObject({ provider: "geoapify", endpoint: "autocomplete", ttlSeconds: 30 * 86400 });
    expect(h.outcomes[0]).toMatchObject({ units: 1 });
    expect(h.quota).toBe(1);
    expect(await autocompletePlaces({ q: "stephansdom ", lat: 48.21, lon: 16.37, lang: "de" }, ctx)).toMatchObject({ ok: true, fetchedAt: "f0" });
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("short or overlong queries, a bad lang or bad coordinates: invalid_query, no call", async () => {
    expect(await autocompletePlaces({ q: " ab ", ...wien, lang: "de" }, ctx)).toEqual({ ok: false, error: "invalid_query" });
    expect(await autocompletePlaces({ q: "x".repeat(101), ...wien, lang: "de" }, ctx)).toEqual({ ok: false, error: "invalid_query" });
    expect(await autocompletePlaces({ q: "Stephansdom", ...wien, lang: "DE" }, ctx)).toEqual({ ok: false, error: "invalid_query" });
    expect(await autocompletePlaces({ q: "Stephansdom", lat: 91, lon: 0, lang: "de" }, ctx)).toEqual({ ok: false, error: "invalid_query" });
    expect(h.calls).toHaveLength(0);
  });

  it("Geoapify down, guard closed or no key: unavailable", async () => {
    h.fetchJson.mockRejectedValue(new HttpError(502));
    expect(await autocompletePlaces({ q: "Stephansdom", ...wien, lang: "de" }, ctx)).toEqual({ ok: false, error: "unavailable" });
    h.quotaOk = false;
    expect(await autocompletePlaces({ q: "Stephansdom", ...wien, lang: "de" }, ctx)).toEqual({ ok: false, error: "unavailable" });
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
    vi.stubEnv("GEOAPIFY_API_KEY", "");
    expect(await autocompletePlaces({ q: "Stephansdom", ...wien, lang: "de" }, ctx)).toEqual({ ok: false, error: "unavailable" });
  });
});

describe("placeDetails", () => {
  const details = fx("place-details-stephansdom-de");
  const id = details.features[0].properties.place_id as string;

  it("resolves the OSM key once (1 credit, 90 days, geoapify/place_details)", async () => {
    h.fetchJson.mockResolvedValue({ status: 200, latencyMs: 680, body: details });
    const d = await placeDetails(id, "de", ctx);
    expect(d).toMatchObject({ osmKey: "osm:w212496461", name: "Stephansdom", cat: "place_of_worship", wikidata: "Q5943", fetchedAt: "f1" });
    expect(h.calls[0]).toMatchObject({ provider: "geoapify", endpoint: "place_details", ttlSeconds: 90 * 86400, key: placeDetailsKey(id, "de") });
    expect(h.outcomes[0]).toMatchObject({ units: 1 });
    await placeDetails(id, "de", ctx);
    expect(h.fetchJson).toHaveBeenCalledTimes(1);
  });

  it("an invalid id or lang: null without a call; a failure: null", async () => {
    expect(await placeDetails("not-hex!", "de", ctx)).toBeNull();
    expect(await placeDetails(id, "deu", ctx)).toBeNull();
    expect(h.calls).toHaveLength(0);
    h.fetchJson.mockRejectedValue(new HttpError(500));
    expect(await placeDetails(id, "de", ctx)).toBeNull();
  });
});
