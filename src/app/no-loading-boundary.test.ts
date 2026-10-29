import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * A route-level `loading.tsx` wraps the page in a Suspense boundary, so Next flushes the shell first and a later
 * `notFound()` (foreign trip, non-admin on /admin, revoked share link) answers HTTP 200 instead of 404. It also made
 * `router.refresh()` after actions show stale content in the E2E run. Loading UI belongs in <Suspense> inside the
 * page, below the data that decides 404 (see docs/specs/phase-6-e2e.md [D11]).
 */
function find(dir: string, name: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) find(path, name, out);
    else if (entry === name) out.push(path);
  }
  return out;
}

describe("app router", () => {
  it("has no route-level loading.tsx", () => {
    expect(find(join(process.cwd(), "src", "app"), "loading.tsx")).toEqual([]);
  });
});
