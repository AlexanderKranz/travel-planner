import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { POINT_REF_TTL_MS, signPointRef, verifyPointRef } from "./point-ref";

const point = { key: "osm:w212496461", name: "Stephansdom", lat: 48.2085, lon: 16.3731, source: "osm" as const, cat: "place_of_worship" };
const T0 = 1_800_000_000_000;

beforeEach(() => vi.stubEnv("SUPABASE_SECRET_KEY", "sb_secret_test"));
afterEach(() => vi.unstubAllEnvs());

describe("signed point references", () => {
  it("round-trips the point for its own key within 24 h", () => {
    const ref = signPointRef(point, undefined, T0);
    expect(verifyPointRef(ref, point.key, T0 + POINT_REF_TTL_MS - 1)?.p).toEqual(point);
    expect(verifyPointRef(ref, point.key, T0 + POINT_REF_TTL_MS + 1)).toBeNull();
  });

  it("is bound to the key: another key with the same ref is rejected", () => {
    const ref = signPointRef(point, undefined, T0);
    expect(verifyPointRef(ref, "osm:n1", T0)).toBeNull();
  });

  it("rejects tampered payloads (coordinates moved) and tampered signatures", () => {
    const ref = signPointRef(point, undefined, T0);
    const [body, sig] = ref.split(".");
    const moved = JSON.parse(Buffer.from(body, "base64url").toString());
    moved.p.lat = 0;
    const forged = `${Buffer.from(JSON.stringify(moved)).toString("base64url")}.${sig}`;
    expect(verifyPointRef(forged, point.key, T0)).toBeNull();
    expect(verifyPointRef(`${body}.${sig.slice(0, -2)}AA`, point.key, T0)).toBeNull();
    expect(verifyPointRef("garbage", point.key, T0)).toBeNull();
    expect(verifyPointRef("a.b.c", point.key, T0)).toBeNull();
  });

  it("a ref signed with another secret is rejected; a missing secret rejects everything", () => {
    const ref = signPointRef(point, undefined, T0);
    vi.stubEnv("SUPABASE_SECRET_KEY", "other");
    expect(verifyPointRef(ref, point.key, T0)).toBeNull();
    vi.stubEnv("SUPABASE_SECRET_KEY", "");
    expect(verifyPointRef(ref, point.key, T0)).toBeNull();
    expect(() => signPointRef(point, undefined, T0)).toThrow();
  });

  it("carries the Geoapify place to resolve on save", () => {
    const gfy = { ...point, key: "gfy:0123456789abcdef0123456789abcdef", source: "geoapify" as const };
    const ref = signPointRef(gfy, { id: "51a0b1c2d3e4f5", osm: true }, T0);
    expect(verifyPointRef(ref, gfy.key, T0)?.g).toEqual({ id: "51a0b1c2d3e4f5", osm: true });
  });
});
