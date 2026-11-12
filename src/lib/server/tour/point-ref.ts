import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { MAX_POINT_REF, TourPoint } from "@/lib/domain/tour";
import { PlaceId } from "@/lib/integrations/geoapify-autocomplete";

/**
 * Signed point references (city tour spec 3.1: the browser never supplies coordinates).
 *
 * Every point the server offers (a cached city place, a Geoapify search result) goes out with a `ref`: the point's
 * key, name, coordinates, source and category, plus the Geoapify `place_id` where the point still has to be resolved
 * to its OSM identity, signed with HMAC-SHA256 and valid for 24 hours. createTour / updateTour accept a new point only
 * with a valid `ref` for exactly that key and take every value from the signed payload, never from the request. No
 * database row per suggestion, no cache lookup by key (the place caches are keyed by query or area, not by point).
 *
 * The HMAC key is derived from SUPABASE_SECRET_KEY (server-only, never sent to the browser) with a fixed label, so no
 * new secret needs to be provisioned; rotating the Supabase key invalidates open references, which is harmless (the
 * user searches again). The payload is readable (base64url JSON), not secret: it only holds public place data.
 */
export const POINT_REF_TTL_MS = 24 * 3_600_000;
const LABEL = "travel-planner:city-tour:point-ref:v1\0";

const SignedPoint = TourPoint.omit({ dwellMin: true });
export type SignedPoint = z.infer<typeof SignedPoint>;

const Payload = z.object({
  v: z.literal(1),
  p: SignedPoint,
  /** Geoapify place to resolve once to its OSM key on save (`osm`: the result came from OpenStreetMap). */
  g: z.object({ id: PlaceId, osm: z.boolean() }).optional(),
  /** Expiry, epoch milliseconds. */
  x: z.number().int(),
});
export type PointRefPayload = z.infer<typeof Payload>;

function hmacKey(): Buffer {
  const secret = process.env.SUPABASE_SECRET_KEY?.trim();
  if (!secret) throw new Error("point refs need SUPABASE_SECRET_KEY");
  return createHash("sha256").update(LABEL).update(secret).digest();
}

const mac = (body: string) => createHmac("sha256", hmacKey()).update(body).digest("base64url");

/** `<base64url(JSON payload)>.<base64url(HMAC)>`. Throws when the secret is missing (server misconfiguration). */
export function signPointRef(
  point: SignedPoint,
  geoapify?: { id: string; osm: boolean },
  now: number = Date.now(),
): string {
  const payload = Payload.parse({ v: 1, p: point, ...(geoapify ? { g: geoapify } : {}), x: now + POINT_REF_TTL_MS });
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const ref = `${body}.${mac(body)}`;
  if (ref.length > MAX_POINT_REF) throw new RangeError("point ref too long");
  return ref;
}

/**
 * The signed payload when `ref` is authentic, unexpired and names `key`; else null. Never throws (a missing secret
 * also gives null, so a misconfigured server rejects points instead of trusting them).
 */
export function verifyPointRef(ref: string, key: string, now: number = Date.now()): PointRefPayload | null {
  try {
    const dot = ref.indexOf(".");
    if (dot <= 0 || dot !== ref.lastIndexOf(".")) return null;
    const body = ref.slice(0, dot);
    const given = Buffer.from(ref.slice(dot + 1), "base64url");
    const want = Buffer.from(mac(body), "base64url");
    if (given.length !== want.length || !timingSafeEqual(given, want)) return null;
    const parsed = Payload.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!parsed.success || parsed.data.x < now || parsed.data.p.key !== key) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
