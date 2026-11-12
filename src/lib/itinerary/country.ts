import { foldText } from "./text";

/**
 * A country printed after the port ("Messina (Sizilien), Italien", "La Valletta, Malta"): the itinerary row keeps the
 * port as the place and the country as its `cc` hint (port-places, implementation note 2026-11-12). Country names
 * come from `Intl.DisplayNames` in German and English (browser and server), plus a few everyday aliases.
 */

/** Region codes that `Intl.DisplayNames` names but that are no current country (deprecated or groupings). */
const NOT_A_COUNTRY = new Set(["AN", "BU", "CS", "DD", "DY", "EU", "EZ", "FX", "HV", "NH", "QO", "RH", "SU", "TP", "UK", "UN", "VD", "YD", "YU", "ZR", "ZZ"]);
/** Everyday names the display names do not give ("Türkiye" is the English display name today). */
const ALIASES: Record<string, string> = {
  turkey: "TR",
  usa: "US",
  uk: "GB",
  england: "GB",
  schottland: "GB",
  scotland: "GB",
  wales: "GB",
  grossbritannien: "GB",
  "great britain": "GB",
  holland: "NL",
  "czech republic": "CZ",
};

let byName: Map<string, string> | null = null;

function countryNames(): Map<string, string> {
  if (byName) return byName;
  const map = new Map<string, string>(Object.entries(ALIASES));
  try {
    const names = ["de", "en"].map((l) => new Intl.DisplayNames([l], { type: "region" }));
    for (let a = 65; a <= 90; a++) {
      for (let b = 65; b <= 90; b++) {
        const code = String.fromCharCode(a, b);
        // X* are private-use codes (pseudo locales), apart from Kosovo.
        if (NOT_A_COUNTRY.has(code) || (code.startsWith("X") && code !== "XK")) continue;
        for (const dn of names) {
          const name = dn.of(code);
          if (name && name !== code && !map.has(foldText(name))) map.set(foldText(name), code);
        }
      }
    }
  } catch {
    // No Intl.DisplayNames: the aliases only.
  }
  byName = map;
  return map;
}

/** ISO code of a country name in German or English ("Italien", "Malta", "Spain"), else null. */
export function countryCodeOf(name: string): string | null {
  const key = foldText(name);
  return key ? (countryNames().get(key) ?? null) : null;
}

/**
 * "Port, Country" -> the port and the country's code. Only a last comma part that is a country is split off, so
 * "Palma, Mallorca" stays as it is. A name without such a part comes back unchanged.
 */
export function splitCountrySuffix(place: string): { place: string; cc?: string } {
  const i = place.lastIndexOf(",");
  if (i <= 0) return { place };
  const head = place.slice(0, i).trim();
  const cc = countryCodeOf(place.slice(i + 1));
  return head && cc ? { place: head, cc } : { place };
}
