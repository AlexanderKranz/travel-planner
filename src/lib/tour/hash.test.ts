import { describe, expect, it } from "vitest";
import { TourInput } from "@/lib/domain/tour";
import { BELVEDERE, HOFBURG, STEPHANSDOM, WIEN_CITY } from "./fixtures.test-data";
import { pointSeqHash, pointSetHash, tourInputHash } from "./hash";

const parse = (v: unknown) => TourInput.parse(v);
const base = { city: WIEN_CITY, places: [STEPHANSDOM, HOFBURG, BELVEDERE], startTime: "10:00" };

describe("tour hashes", () => {
  it("is stable under object key order and defaults", () => {
    const a = parse(base);
    const b = parse({
      startTime: "10:00",
      mode: "foot",
      order: "optimize",
      places: base.places.map((p) => Object.fromEntries(Object.entries(p).reverse())),
      city: WIEN_CITY,
    });
    expect(tourInputHash(a)).toBe(tourInputHash(b));
    const o1 = { "osm:w1>osm:w2": { mode: "foot", route: "green" }, "osm:w2>osm:w4": { mode: "car", route: "fastest" } };
    const o2 = Object.fromEntries(Object.entries(o1).reverse());
    expect(tourInputHash(parse({ ...base, legOverrides: o1 }))).toBe(tourInputHash(parse({ ...base, legOverrides: o2 })));
  });

  it("rounds points to 5 decimals and ignores title and names", () => {
    const h = tourInputHash(parse(base));
    const jitter = { ...STEPHANSDOM, lat: STEPHANSDOM.lat + 1e-7, name: "St. Stephan" };
    expect(tourInputHash(parse({ ...base, title: "Mein Tag", places: [jitter, HOFBURG, BELVEDERE] }))).toBe(h);
    expect(tourInputHash(parse({ ...base, places: [{ ...STEPHANSDOM, lat: 48.2086 }, HOFBURG, BELVEDERE] }))).not.toBe(h);
  });

  it("changes with order, options, dwell and times", () => {
    const h = tourInputHash(parse(base));
    const variants = [
      { places: [HOFBURG, STEPHANSDOM, BELVEDERE] },
      { order: "keep" },
      { route: "green" },
      { dwellDefaultMin: 45 },
      { places: [{ ...STEPHANSDOM, dwellMin: 60 }, HOFBURG, BELVEDERE] },
      { startTime: "11:00" },
      { date: "2026-12-15" },
      { end: "start", start: WIEN_CITY },
    ];
    const hashes = variants.map((v) => tourInputHash(parse({ ...base, ...v })));
    expect(new Set([h, ...hashes]).size).toBe(variants.length + 1);
  });

  it("point set hash ignores order, sequence hash does not", () => {
    const pts = [STEPHANSDOM, HOFBURG, BELVEDERE];
    const rev = [...pts].reverse();
    expect(pointSetHash(pts)).toBe(pointSetHash(rev));
    expect(pointSeqHash(pts)).not.toBe(pointSeqHash(rev));
    expect(pointSetHash(pts)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("separators inside keys cannot make two point lists collide", () => {
    const P = (key: string, n: number) => ({ key, lat: n, lon: n });
    const x = [P("a", 0), P("b@1.00000,1.00000|c", 2)];
    const y = [P("a", 0), P("b", 1), P("c", 2)];
    expect(pointSeqHash(x)).not.toBe(pointSeqHash(y));
    expect(pointSetHash(x)).not.toBe(pointSetHash(y));
  });
});
