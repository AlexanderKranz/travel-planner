const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").trim();

/** The place name without an explicit sub-area: "Wien: Innenstadt" -> "wien", "Melk (Stift)" -> "melk". */
const name = (s: string) => fold(s.split(/[(:,–—/]| - /)[0]);

/**
 * Does a plan stop's place name denote the wanted place? Accents and case are ignored. The complete names must be
 * equal; an explicit sub-area ("Wien: Innenstadt", "Melk (Stift)") may follow the name on either side. A longer name
 * is another place: "Wiener Neustadt" is not "Wien". Moved here from `evals/checks.ts` so the port-window guard in
 * assembly and the eval check use one rule (port-places section 3).
 */
export function placeMatches(stopPlace: string, wanted: string): boolean {
  const a = name(stopPlace);
  return a !== "" && a === name(wanted);
}
