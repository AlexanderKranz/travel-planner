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

  if (!blocked.has(host)) {
    blocked.add(host);
    console.warn(`[e2e-stub] blocked external request to ${host}`);
  }
  return json({ error: "blocked by e2e stub" }, 503);
};
console.warn("[e2e-stub] external fetch stub active");
