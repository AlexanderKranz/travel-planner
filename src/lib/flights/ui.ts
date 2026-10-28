import type { FlightLeg, FlightPair, FlightsFacts } from "@/lib/domain/flights";
import type { ResolvedEntry } from "@/lib/group";

export function durationParts(min: number): { h: number; m: string } {
  const total = Math.max(0, Math.round(min));
  return { h: Math.floor(total / 60), m: String(total % 60).padStart(2, "0") };
}

/** Hours for the "over your N h limit" text: 180 -> 3, 210 -> 3.5. */
export function limitHours(maxBlockMin: number): number {
  return Math.round((maxBlockMin / 60) * 10) / 10;
}

export type PairState = "found" | "foundProxy" | "none" | "notPublished" | "notChecked";

/** A found pair is only "verified" when every shown direction comes from the published schedule. */
export function pairState(pair: FlightPair, mode: FlightsFacts["mode"], legs: FlightLeg[]): PairState {
  if (pair.status === "none") return "none";
  if (pair.status === "not_published") return "notPublished";
  if (pair.status === "not_checked") return "notChecked";
  const dirs = (["out", "back"] as const).filter((d) => legsOfPair(pair, legs, d).length > 0);
  const checked = dirs.length > 0 ? dirs : (["out", "back"] as const);
  return checked.some((d) => mode[d] === "proxy") ? "foundProxy" : "found";
}

/** Legs of one direction for one origin x gateway pair (out: O to G, back: G to O). */
export function legsOfPair(pair: FlightPair, legs: FlightLeg[], dir: "out" | "back"): FlightLeg[] {
  return legs.filter((l) =>
    l.dir === dir && (dir === "out" ? l.from === pair.from && l.to === pair.to : l.from === pair.to && l.to === pair.from),
  );
}

/** Passengers aged 12+ or of unknown age count as adults for the booking links; at least 1. */
export function adultsFromEntries(entries: ResolvedEntry[] | undefined | null): number {
  if (!entries || entries.length === 0) return 1;
  const n = entries.reduce((sum, e) => (e.age.status === "known" && e.age.age < 12 ? sum : sum + e.count), 0);
  return Math.max(1, n);
}

/** Pairs sorted found first is done by the server; the UI keeps that order. Distinct fitting legs only. */
export function fittingLegs<T extends { tooLong?: true }>(legs: T[]): T[] {
  return legs.filter((l) => !l.tooLong);
}
