// Copies the MapLibre GL worker into public/vendor before `next dev` / `next build` (city tour map, spec 8).
// MapLibre v6 starts its worker from a separate module file next to its own bundle; a bundled chunk has no such
// sibling, so the tour map sets `setWorkerUrl("/vendor/maplibre-gl-worker.mjs")` and the file is served same-origin.
// The copy is generated (gitignored), never edited by hand.
import { copyFileSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(import.meta.url);
const pkgDir = path.dirname(require.resolve("maplibre-gl/package.json", { paths: [root] }));
const src = path.join(pkgDir, "dist", "maplibre-gl-worker.mjs");
const outDir = path.join(root, "public", "vendor");
mkdirSync(outDir, { recursive: true });
copyFileSync(src, path.join(outDir, "maplibre-gl-worker.mjs"));
console.log("maplibre worker copied to public/vendor/");
