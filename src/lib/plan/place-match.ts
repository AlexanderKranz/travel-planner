const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/ß/g, "ss").trim();

/**
 * Does a plan stop's place name denote the wanted place? Accents and case are ignored and one name may contain the
 * other ("Wien" / "Wien: Innenstadt", "Melk (Stift)" / "Melk"). Moved here from `evals/checks.ts` so the port-window
 * guard in assembly and the eval check use one rule (port-places section 3).
 */
export function placeMatches(stopPlace: string, wanted: string): boolean {
  const a = fold(stopPlace);
  const b = fold(wanted);
  return a.includes(b) || b.includes(a);
}
