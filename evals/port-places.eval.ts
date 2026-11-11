/**
 * Records the lookups the port-places evals replay (docs/specs/port-places.md section 9): Open-Meteo geocoding of the
 * cruise stops and the Overpass answers around them (restaurants, family_activities, general). Keyless, no Anthropic
 * cost, no ledger. Run: `npm run evals:port-places`; writes `evals/recorded/cruise.stoplookups.json`.
 * Overpass answers in 25-60 s per query, so a run takes about ten minutes.
 */
import { writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { GeoPlace } from "@/lib/domain/geo";
import { sourceFor, radiusForInterest } from "@/lib/facts/interest-sources";
import { fetchJson } from "@/lib/integrations/http";
import { parseSearchResponse } from "@/lib/integrations/open-meteo-geocoding";
import { buildQuery, runQuery, type RawOsmElement } from "@/lib/integrations/overpass";
import { OVERPASS_LIMIT, RESTAURANT_RADIUS_KM } from "@/lib/server/facts/activities";
import { haversineKm } from "@/lib/facts/places";
import { resolvePlaceName, type GeocodeDeps } from "@/lib/server/discover/resolve-place";
import { STOP_RECORDING_PATH, STOP_NAMES, readStopRecording, type StopRecording } from "./port-places";

vi.mock("server-only", () => ({}));

const LIVE = process.env.EVAL_LIVE === "1";
const trim = (els: RawOsmElement[], center: { lat: number; lon: number }, keep: number) =>
  [...els].sort((a, b) => haversineKm(center, a) - haversineKm(center, b)).slice(0, keep);

describe.runIf(LIVE)("port places: record geocoding and lookups of the cruise stops", () => {
  it("records", async () => {
    const geocode: StopRecording["geocode"] = {};
    for (const name of STOP_NAMES) {
      geocode[name] = {};
      for (const lang of ["en", "de"] as const) {
        const r = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name.toLowerCase())}&count=8&language=${lang}&format=json`);
        geocode[name][lang] = parseSearchResponse(r.body);
      }
    }
    const replay: GeocodeDeps = {
      geocode: async (name, lang) => ({ ok: true, data: (geocode[name]?.[lang as "en" | "de"] ?? []) as GeoPlace[], fetchedAt: "recorded", stale: false, cache: "hit" }),
      placeById: async () => null,
    };
    // Resumable: a stop recorded by an earlier run is kept; the file is written after every stop.
    const lookups: StopRecording["lookups"] = readStopRecording()?.lookups ?? {};
    const save = () => writeFileSync(STOP_RECORDING_PATH, JSON.stringify({ recordedAt: new Date().toISOString(), source: "open-meteo geocoding + overpass-api.de", geocode, lookups } satisfies StopRecording) + "\n");
    save();
    // Passau is the destination: its places are the destination's, no stop lookups.
    for (const name of STOP_NAMES.filter((n) => n !== "Passau")) {
      if (lookups[name]?.restaurants && lookups[name]?.general) continue;
      const r = await resolvePlaceName(name, "AT", "de", "eval", replay);
      expect(r.status, `${name} resolves`).toBe("ok");
      if (r.status !== "ok") continue;
      const point = { lat: r.place.lat, lon: r.place.lon, geoId: r.place.geoId };
      const rec: StopRecording["lookups"][string] = { point, name: r.place.name };
      const run = async (filters: string[], radiusKm: number, limit: number, keep: number) => {
        try {
          const q = await runQuery(buildQuery(filters, point, radiusKm * 1000, limit));
          return { elements: trim(q.elements, point, keep) };
        } catch (e) {
          console.log(`[${name}] query failed: ${e instanceof Error ? e.message : "unknown"}`);
          return null;
        }
      };
      rec.restaurants = await run([`["amenity"="restaurant"]`], RESTAURANT_RADIUS_KM.city, OVERPASS_LIMIT, 200);
      for (const key of ["family_activities", "general"] as const) {
        const src = sourceFor(key);
        if (src.source !== "osm") continue;
        rec[key] = await run([...src.filters], radiusForInterest(key, 15), 150, 150);
      }
      lookups[name] = rec;
      save();
      console.log(`[${name}] recorded: ${Object.entries(rec).filter(([, v]) => v && typeof v === "object" && "elements" in v).map(([k, v]) => `${k}=${(v as { elements: unknown[] }).elements.length}`).join(", ")}`);
    }
    save();
  }, 3_000_000);
});
