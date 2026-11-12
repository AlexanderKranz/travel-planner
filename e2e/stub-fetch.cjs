// Preloaded into the Next.js SERVER process only by the Playwright webServer command
// (NODE_OPTIONS=--require ./e2e/stub-fetch.cjs). Lives outside src/, so it can never ship with the app.
// Answers the keyless providers from the recorded fixtures and refuses every other external host,
// so CI makes no real external call. Requests to localhost / 127.0.0.1 (local Supabase, the app itself) pass through.
const fs = require("node:fs");
const path = require("node:path");

const FIX = path.join(__dirname, "..", "src", "lib", "integrations", "__fixtures__");
const read = (...p) => fs.readFileSync(path.join(FIX, ...p), "utf8");
const json = (body, status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const realFetch = globalThis.fetch;
const blocked = new Set();

// --- City tours (docs/specs/city-tour.md). Only the tours server (port 3001) has ORS and Geoapify keys. ---------------
// Places the stubbed autocomplete knows: the Passau spike points (section 14). The answer has the recorded shape
// (`geoapify-autocomplete/autocomplete-stephansdom-wien-de.json`), with these names and coordinates.
const TOUR_PLACES = [
  { q: "dom", name: "Dom St. Stephan", lat: 48.5741, lon: 13.4648, osmType: "w", osmId: 24392801, cat: "place_of_worship" },
  { q: "rathaus", name: "Rathaus Passau", lat: 48.5746, lon: 13.4672, osmType: "w", osmId: 24392802, cat: "townhall" },
  { q: "ortspitze", name: "Ortspitze", lat: 48.5737, lon: 13.4774, osmType: "n", osmId: 24392803, cat: "viewpoint" },
  { q: "veste", name: "Veste Oberhaus", lat: 48.5775, lon: 13.4718, osmType: "w", osmId: 24392804, cat: "castle" },
].map((p) => ({ ...p, placeId: Buffer.from(p.name, "utf8").toString("hex") }));

const autocompleteTemplate = JSON.parse(read("geoapify-autocomplete", "autocomplete-stephansdom-wien-de.json")).results[0];

function autocompleteBody(text) {
  const q = (text || "").toLowerCase();
  const results = TOUR_PLACES.filter((p) => q.includes(p.q) || p.name.toLowerCase().includes(q)).map((p) => ({
    datasource: autocompleteTemplate.datasource,
    name: p.name,
    country: "Deutschland",
    city: "Passau",
    lat: p.lat,
    lon: p.lon,
    result_type: "amenity",
    address_line1: p.name,
    address_line2: "94032 Passau, Deutschland",
    category: `tourism.${p.cat}`,
    place_id: p.placeId,
    distance: 300,
  }));
  return { results, query: { text: q } };
}

function placeDetailsBody(id) {
  const p = TOUR_PLACES.find((x) => x.placeId === id);
  if (!p) return null;
  return {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: {
          feature_type: "details",
          name: p.name,
          lat: p.lat,
          lon: p.lon,
          datasource: { sourcename: "openstreetmap", raw: { osm_type: p.osmType, osm_id: p.osmId, name: p.name, tourism: p.cat } },
        },
        geometry: { type: "Point", coordinates: [p.lon, p.lat] },
      },
    ],
  };
}

/** Encoded polyline, precision 5 (the format ORS returns). */
function encodePolyline(points) {
  let out = "";
  let pLat = 0;
  let pLon = 0;
  const put = (v) => {
    let n = v < 0 ? ~(v << 1) : v << 1;
    while (n >= 0x20) {
      out += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
      n >>>= 5;
    }
    out += String.fromCharCode(n + 63);
  };
  for (const [lat, lon] of points) {
    const a = Math.round(lat * 1e5);
    const b = Math.round(lon * 1e5);
    put(a - pLat);
    put(b - pLon);
    pLat = a;
    pLon = b;
  }
  return out;
}

const KMH = { "foot-walking": 5, wheelchair: 4, "cycling-regular": 15, "driving-car": 30 };
function metres([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180;
  const x = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(x)) * 1.3; // a street is longer than the straight line
}
const seconds = (profile, m) => (m / 1000 / KMH[profile]) * 3600;

/** Matrix in the recorded shape (`ors-tour/matrix-foot-wien.json`), durations from the straight line per profile. */
function tourMatrixBody(profile, body) {
  const locs = body.locations;
  const durations = locs.map((a) => locs.map((b) => Math.round(seconds(profile, metres(a, b)) * 10) / 10));
  const sources = locs.map((l) => ({ location: l, snapped_distance: 5 }));
  return { durations, sources, destinations: sources, metadata: { service: "matrix", engine: { version: "10.1.0" } } };
}

/** Directions in the recorded shape (`ors-tour/directions-foot-passau-fastest.json`): one segment per leg, midpoints. */
function tourDirectionsBody(profile, body) {
  const c = body.coordinates;
  const pts = [];
  const wayPoints = [];
  c.forEach(([lon, lat], i) => {
    if (i > 0) {
      const [plon, plat] = c[i - 1];
      pts.push([(plat + lat) / 2 + 0.0004, (plon + lon) / 2]);
    }
    wayPoints.push(pts.length);
    pts.push([lat, lon]);
  });
  const segments = c.slice(1).map((b, i) => {
    const m = metres(c[i], b);
    return { distance: Math.round(m) / 1000, duration: Math.round(seconds(profile, m) * 10) / 10 };
  });
  const distance = segments.reduce((s, x) => s + x.distance, 0);
  const duration = segments.reduce((s, x) => s + x.duration, 0);
  return {
    metadata: { service: "routing", engine: { version: "10.1.0" } },
    routes: [{ summary: { distance, duration }, segments, way_points: wayPoints, geometry: encodePolyline(pts) }],
  };
}

const bodyOf = (init) => {
  try {
    return typeof init?.body === "string" ? JSON.parse(init.body) : null;
  } catch {
    return null;
  }
};

globalThis.fetch = async function stubbedFetch(input, init) {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const host = url.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return realFetch(input, init);

  if (host === "geocoding-api.open-meteo.com") {
    if (url.pathname.endsWith("/search")) {
      const q = (url.searchParams.get("name") || "").toLowerCase();
      return q.includes("passau") ? json(read("open-meteo", "geocoding-search-passau-de.json")) : json({});
    }
    if (url.pathname.endsWith("/get")) return json(read("open-meteo", "geocoding-get-2855328.json"));
  }
  if (host === "archive-api.open-meteo.com") return json(read("open-meteo", "archive-malaga-2016-2025.json"));
  if (host.endsWith("wikivoyage.org")) return json(read("wikivoyage", "geosearch-passau-de.json"));
  if (/overpass|maps\.mail\.ru/.test(host)) return json(read("overpass", "general-passau-15km.json"));

  // City tours: Geoapify Autocomplete + Place Details, ORS tour matrix + directions (synthetic, recorded shapes).
  // Geoapify Places (`/v2/places`) stays blocked: city places then come from the Overpass cache like without a key.
  if (host === "api.geoapify.com") {
    if (url.pathname === "/v1/geocode/autocomplete") return json(autocompleteBody(url.searchParams.get("text")));
    if (url.pathname === "/v2/place-details") {
      const body = placeDetailsBody(url.searchParams.get("id"));
      return body ? json(body) : json({ type: "FeatureCollection", features: [] });
    }
  }
  if (host === "api.heigit.org") {
    const m = /^\/openrouteservice\/v2\/(matrix|directions)\/([a-z-]+)(\/json)?$/.exec(url.pathname);
    const body = bodyOf(init);
    if (m && body && KMH[m[2]]) {
      if (m[1] === "matrix" && Array.isArray(body.locations) && !body.sources) return json(tourMatrixBody(m[2], body));
      if (m[1] === "directions" && Array.isArray(body.coordinates) && body.instructions === true) return json(tourDirectionsBody(m[2], body));
    }
  }

  if (!blocked.has(host)) {
    blocked.add(host);
    console.warn(`[e2e-stub] blocked external request to ${host}`);
  }
  return json({ error: "blocked by e2e stub" }, 503);
};
console.warn("[e2e-stub] external fetch stub active");
