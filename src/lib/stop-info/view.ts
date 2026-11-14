/**
 * What is stored and what still needs a fetch (docs/specs/city-tour-stop-info.md section 5). Pure.
 *
 * Eligible stops are the tour's `osm:` points. An entry counts while it is younger than 30 days and the stored
 * locale is the owner's current one; otherwise its key is pending (fetched on the next expand).
 */
import { STOP_INFO_REFRESH_DAYS, TourStopInfo, type StopInfo, type StopInfoLocale } from "@/lib/domain/stop-info";
import type { TourInput } from "@/lib/domain/tour";
import { tourPointsOf } from "@/lib/tour/points";
import { osmRefOf } from "./match";

export type StopPointRef = { key: string; cat?: string };

/** The tour's points that can get a card, in tour order (start, places, end), each once. */
export function eligibleStops(input: Pick<TourInput, "places" | "start" | "end" | "dwellDefaultMin">): StopPointRef[] {
  const seen = new Set<string>();
  const out: StopPointRef[] = [];
  for (const p of tourPointsOf(input).points) {
    if (seen.has(p.key) || !osmRefOf(p.key)) continue;
    seen.add(p.key);
    out.push({ key: p.key, ...(p.cat ? { cat: p.cat } : {}) });
  }
  return out;
}

export function storedView(
  raw: unknown,
  eligible: readonly StopPointRef[],
  ownerLocale: StopInfoLocale,
  now: number = Date.now(),
): { stops: StopInfo[]; pending: string[] } {
  const parsed = TourStopInfo.safeParse(raw);
  const usable = parsed.success && parsed.data.locale === ownerLocale ? parsed.data.stops : [];
  const byKey = new Map(usable.map((s) => [s.key, s]));
  const maxAge = STOP_INFO_REFRESH_DAYS * 86_400_000;
  const stops: StopInfo[] = [];
  const pending: string[] = [];
  for (const p of eligible) {
    const s = byKey.get(p.key);
    const at = s ? Date.parse(s.checkedAt) : NaN;
    if (s && Number.isFinite(at) && now - at < maxAge) stops.push(s);
    else pending.push(p.key);
  }
  return { stops, pending };
}
