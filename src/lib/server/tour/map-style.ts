import "server-only";

/**
 * Map style of the tour map (spec 8 [T13]): OpenFreeMap vector tiles, free, no key, no quota. `positron` is the calm
 * light style that suits the Atlas palette. `TOUR_MAP_STYLE_URL` overrides it (https only); `off` disables the map,
 * which then shows "Karte nicht verfügbar" and the route sketch (E2E sets it, so no tile is ever fetched there).
 */
export const OPENFREEMAP_STYLE_URL = "https://tiles.openfreemap.org/styles/positron";

export function tourMapStyleUrl(env: Record<string, string | undefined> = process.env): string | null {
  const v = env.TOUR_MAP_STYLE_URL?.trim();
  if (!v) return OPENFREEMAP_STYLE_URL;
  if (v === "off") return null;
  return /^https:\/\/[^\s]+$/.test(v) ? v : OPENFREEMAP_STYLE_URL;
}
