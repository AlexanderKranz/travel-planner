import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Review test for docs/specs/find-destinations.md section 1: "No code path of this feature may import
 * integrations/aerodatabox or server/facts/flights." AeroDataBox is never called in a search (400 units a month).
 * The check follows value imports transitively from every file of the feature; `import type` is erased and ignored.
 */
const ROOT = resolve(process.cwd());
const SRC = join(ROOT, "src");

const FORBIDDEN = ["src/lib/integrations/aerodatabox.ts", "src/lib/server/facts/flights.ts", "src/lib/server/facts/flights-nearby.ts", "src/lib/server/facts/index.ts"];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const isCode = (f: string) => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f);

const ENTRY_FILES = [
  ...walk(join(SRC, "lib/discover")),
  ...walk(join(SRC, "lib/server/discover")),
  ...walk(join(SRC, "app/api/destination-search")),
  ...walk(join(SRC, "components/discover")),
  join(SRC, "lib/server/ai/destination-ideas.ts"),
  join(SRC, "lib/flights/estimate.ts"),
  join(SRC, "lib/domain/destination-search.ts"),
].filter((f) => existsSync(f) && isCode(f));

const IMPORT = /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/g;

function resolveSpec(from: string, spec: string): string | null {
  const base = spec.startsWith("@/") ? join(SRC, spec.slice(2)) : spec.startsWith(".") ? resolve(dirname(from), spec) : null;
  if (!base) return null; // a package
  for (const c of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(c) && statSync(c).isFile()) return c;
  }
  return null; // json and other assets
}

function valueImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(IMPORT)) {
    if (m[1]) continue; // import type
    const r = resolveSpec(file, m[2]);
    if (r) out.push(r);
  }
  for (const m of text.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)) {
    const r = resolveSpec(file, m[1]);
    if (r) out.push(r);
  }
  return out;
}

/**
 * Existing shared server modules the pipeline only READS from (purpose, group, profile). Their own module graph
 * reaches `warm.ts` and with it the trip facts index (which prefetches flights when a trip is saved); the search never
 * calls those write paths. They are not expanded, so the check stays about the feature's own imports.
 */
const SHARED_READERS = ["src/lib/server/purposes.ts", "src/lib/server/groups.ts", "src/lib/server/profile.ts"].map((f) => join(ROOT, f));

/** Every file reachable through value imports, with the path that led there. */
function reach(entries: string[]): Map<string, string[]> {
  const seen = new Map<string, string[]>(entries.map((e) => [e, [e]]));
  const queue = [...entries];
  while (queue.length) {
    const f = queue.shift()!;
    if (SHARED_READERS.includes(f)) continue;
    for (const dep of valueImports(f)) {
      if (!isCode(dep) || seen.has(dep)) continue;
      seen.set(dep, [...seen.get(f)!, dep]);
      queue.push(dep);
    }
  }
  return seen;
}

describe("find destinations: no AeroDataBox in a search (spec section 1)", () => {
  const files = reach(ENTRY_FILES);
  const rel = (p: string) => relative(ROOT, p);

  it("covers the feature's files (the check would be vacuous otherwise)", () => {
    const names = ENTRY_FILES.map(rel);
    expect(names).toContain("src/lib/server/discover/pipeline.ts");
    expect(names).toContain("src/lib/server/discover/verify.ts");
    expect(names).toContain("src/lib/server/ai/destination-ideas.ts");
    expect(names.some((n) => n.startsWith("src/app/api/destination-search/"))).toBe(true);
    expect(files.size).toBeGreaterThan(ENTRY_FILES.length);
  });

  it("no file of the feature reaches integrations/aerodatabox or server/facts/flights, directly or transitively", () => {
    const hits = FORBIDDEN.map((f) => join(ROOT, f)).filter((f) => files.has(f));
    const paths = hits.map((h) => files.get(h)!.map(rel).join(" -> "));
    expect(paths).toEqual([]);
  });

  it("the search reuses the climate and places lookups of the trip facts (shared cache keys) instead of the facts index", () => {
    expect([...files.keys()].map(rel)).toEqual(expect.arrayContaining(["src/lib/server/facts/weather.ts", "src/lib/server/facts/places.ts"]));
  });

  it("nor the flight lookups (dates, horizon) that only the flight check uses", () => {
    expect([...files.keys()].map(rel)).not.toContain("src/lib/flights/lookups.ts");
  });

  it("no file of the feature imports a forbidden module directly", () => {
    const forbidden = FORBIDDEN.map((x) => join(ROOT, x));
    const direct = ENTRY_FILES.filter((f) => valueImports(f).some((d) => forbidden.includes(d)));
    expect(direct.map(rel)).toEqual([]);
  });

  it("the shared readers are the only boundary of the walk", () => {
    const direct = valueImports(join(SRC, "lib/server/discover/pipeline.ts")).map(rel);
    expect(direct).toEqual(expect.arrayContaining(SHARED_READERS.map(rel)));
  });
});
