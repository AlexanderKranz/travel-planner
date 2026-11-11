/**
 * Stops in the plan input (docs/specs/port-places.md section 3, plan-8): the schedule rows (`trip.stops`, with the
 * code-set `at`) and the verified places per stop (`stopPlaces`). Pure; the lookups happen in
 * `src/lib/server/facts/stops.ts`. Trips without stops never reach this code, so their input and hash stay as they were.
 */
import type { LookupStatus, PlaceGroup, ResolvedStop, StopFacts } from "@/lib/domain/facts";
import type { Locale } from "@/lib/domain/profile";
import type { TripStop } from "@/lib/domain/trip-stops";
import type { CuisineWish } from "@/lib/facts/cuisine";
import { cafesInput, maxId, restaurantsInput, type CafesInput, type RestaurantsInput } from "./activities-input";
import { interestPlace, withInterest, type DriveInput, type PlanIndexEntry, type PlanInputPlace, type PlanInputStored } from "./input";
import { stopOfRow } from "./stops-resolve";

/** Places per interest, restaurants and cafés kept per stop (port-places [P4]). */
export const STOP_PLACES_PER_INTEREST = 4;
export const STOP_RESTAURANTS = 6;
export const STOP_CAFES = 3;

/** A row of `trip.stops`: the schedule as the model sees it. `at` = "dest" or a stop id; absent on sea days. */
export type StopRow = { day: number; place?: string; arr?: string; dep?: string; sea?: true; note?: string; at?: string };

/** Everything the model may know about one stop. `s` = nothing could be looked up. */
export type StopPlacesEntry = {
  id: string;
  name: string;
  s?: "not_found" | "error" | "skipped" | "cap";
  places?: Omit<PlanInputPlace, "min" | "ap">[];
  restaurants?: Omit<RestaurantsInput, "ask" | "near">;
  cafes?: Omit<CafesInput, "near" | "kids">;
};

/** Where a stop is, stored beside the input (not hashed, not sent to the model): patches search around it. */
export type StopPoints = Record<string, { lat: number; lon: number; geoId: number }>;

const failedStatus = (s: LookupStatus | undefined) => s === "error" || s === "skipped";
const defined = <T extends object>(o: T): T => {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
};

/**
 * `error` or `skipped` when nothing usable came back for an ok stop: restaurants failed and no interest group of the
 * stop answered. A partly working stop has no `s`; its `restaurants.s` and the missing places speak for themselves.
 */
export function stopLookupStatus(f: Pick<StopFacts, "places" | "restaurants" | "cafes">): "error" | "skipped" | undefined {
  const r = f.restaurants;
  if (!r || !failedStatus(r.status)) return undefined;
  const usable = f.places.some((g) => g.status === "ok" || g.status === "empty");
  if (usable) return undefined;
  return r.status === "skipped" ? "skipped" : "error";
}

/** Something of the stop is missing because a lookup failed or was skipped (retry jobs, `placesIncomplete`). */
export function stopPending(f: Pick<StopFacts, "stop" | "places" | "restaurants" | "cafes">): boolean {
  if (f.stop.role !== "stop" || f.stop.status !== "ok") return false;
  return failedStatus(f.restaurants?.status) || failedStatus(f.cafes?.status) || f.places.some((g) => g.status === "error");
}

/** `trip.stops` of the input: every stop row, with `at` once the stops are resolved. Pure. */
export function stopRows(stops: readonly TripStop[], resolved: readonly ResolvedStop[]): StopRow[] {
  return stops.map((s) => {
    const r = stopOfRow(s, resolved);
    return defined({
      day: s.day,
      place: s.place,
      arr: s.arr,
      dep: s.dep,
      sea: s.sea,
      note: s.note,
      at: r ? (r.role === "destination" ? "dest" : r.id) : undefined,
    }) as StopRow;
  });
}

export type StopsInputArgs = {
  facts: readonly StopFacts[];
  lang: Locale;
  /** The destination's cuisine wish: the filter of a stop's restaurants (no `ask` is sent for stops). */
  cuisine?: CuisineWish | null;
  countryCode?: string | null;
  /** OSM key -> id of everything already in the index. Mutated: new places are added. */
  known: Map<string, string>;
  /** The index so far (for the next free p, r and c numbers). */
  index: Record<string, PlanIndexEntry>;
  /** Drive times from each stop point, by stop id. */
  drive?: Readonly<Record<string, DriveInput | null | undefined>>;
};

/** `stopPlaces` of the input, and the index entries of the places they list (tagged with their stop). Pure. */
export function stopsInput(a: StopsInputArgs): { stopPlaces: StopPlacesEntry[]; index: Record<string, PlanIndexEntry> } {
  const added: Record<string, PlanIndexEntry> = {};
  const all = () => ({ ...a.index, ...added });
  const stopPlaces: StopPlacesEntry[] = [];
  for (const f of a.facts) {
    const stop = f.stop;
    if (stop.role !== "stop") continue;
    const entry: StopPlacesEntry = { id: stop.id, name: stop.name };
    if (stop.status !== "ok") {
      entry.s = stop.status;
      stopPlaces.push(entry);
      continue;
    }
    const s = stopLookupStatus(f);
    if (s) entry.s = s;
    const drive = a.drive?.[stop.id];

    const rows = new Map<string, Omit<PlanInputPlace, "min" | "ap">>();
    let pn = maxId(all(), "p");
    for (const g of f.places as PlaceGroup[]) {
      if (g.status !== "ok") continue;
      for (const c of g.candidates.slice(0, STOP_PLACES_PER_INTEREST)) {
        const key = `${c.osmType}/${c.osmId}` as PlanIndexEntry["key"];
        const have = rows.get(key);
        if (have) {
          // The same place under another interest of this stop; "general" says nothing a specific interest does not.
          if (g.interest !== "general") rows.set(key, withInterest(have, g.interest));
          continue;
        }
        const knownId = a.known.get(key);
        const id = knownId ?? `p${++pn}`;
        const built = interestPlace({ interest: g.interest, c, key, fetchedAt: g.fetchedAt }, id, { lang: a.lang, drive, ...(drive ? { driveFrom: stop.name } : {}) });
        if (!knownId) {
          added[id] = { ...built.entry, stop: stop.id };
          a.known.set(key, id);
        }
        // Stop rows have no `min` (the drive time sits on the place) and no `ap`.
        rows.set(key, { id: built.row.id, name: built.row.name, cat: built.row.cat, km: built.row.km, i: built.row.i });
      }
    }
    if (rows.size) entry.places = [...rows.values()];

    if (f.restaurants) {
      const r = restaurantsInput(f.restaurants, { cuisine: a.cuisine, countryCode: a.countryCode, known: a.known, startN: maxId(all(), "r"), limit: STOP_RESTAURANTS });
      for (const [id, e] of Object.entries(r.index)) {
        added[id] = { ...e, stop: stop.id };
        a.known.set(e.key, id);
      }
      if (r.block) {
        const { ask: _ask, near: _near, ...block } = r.block;
        void _ask;
        void _near;
        entry.restaurants = block;
      }
    }
    if (f.cafes) {
      const c = cafesInput(f.cafes, { kids: a.cuisine?.kids, known: a.known, startN: maxId(all(), "c"), limit: STOP_CAFES });
      for (const [id, e] of Object.entries(c.index)) {
        added[id] = { ...e, stop: stop.id };
        a.known.set(e.key, id);
      }
      if (c.block) {
        const { near: _near, kids: _kids, ...block } = c.block;
        void _near;
        void _kids;
        entry.cafes = block;
      }
    }
    stopPlaces.push(entry);
  }
  return { stopPlaces, index: added };
}

/** The places of a stop that go into the input (and so get a drive time): the first few of each interest group. */
export function stopDrivePicks(f: Pick<StopFacts, "places">): { key: string; lat: number; lon: number }[] {
  const out = new Map<string, { key: string; lat: number; lon: number }>();
  for (const g of f.places) {
    if (g.status !== "ok") continue;
    for (const c of g.candidates.slice(0, STOP_PLACES_PER_INTEREST)) {
      const key = `${c.osmType}/${c.osmId}`;
      if (!out.has(key)) out.set(key, { key, lat: c.lat, lon: c.lon });
    }
  }
  return [...out.values()];
}

/** Stop points to store beside the input: every looked-up stop. */
export function stopPointsOf(resolved: readonly ResolvedStop[]): StopPoints {
  const out: StopPoints = {};
  for (const r of resolved) if (r.role === "stop" && r.status === "ok" && r.point) out[r.id] = { ...r.point };
  return out;
}

/** Stops of an input as resolved stops again (for lookups around them): id, name, point, days from the rows. Pure. */
export function resolvedFromInput(stored: Pick<PlanInputStored, "llm" | "stopPoints">): ResolvedStop[] {
  const rows = stored.llm.trip?.stops ?? [];
  return (stored.llm.stopPlaces ?? []).map((p) => {
    const point = stored.stopPoints?.[p.id];
    const days = [...new Set(rows.filter((r) => r.at === p.id).map((r) => r.day))].sort((x, y) => x - y);
    return defined({ id: p.id, name: p.name, days, role: "stop" as const, point, status: point ? ("ok" as const) : p.s === "not_found" ? ("not_found" as const) : p.s === "cap" ? ("cap" as const) : ("error" as const) });
  });
}

/**
 * Stored input + stop lookups -> the input of the new version (pure): `trip.stops` (when `rows` is given) and the
 * `stopPlaces` entries of `facts` (an entry with the same id is replaced, others keep their place), with the stop
 * points. Used for upgrading a plan made before plan-8 (rows + every stop) and for retrying failed stops (their
 * entries only). Every old index entry stays, so refs of untouched days remain valid.
 */
export function extendInputWithStops(
  stored: PlanInputStored,
  a: Omit<StopsInputArgs, "known" | "index"> & { rows?: StopRow[]; points?: StopPoints },
): PlanInputStored {
  const known = new Map(Object.entries(stored.index).map(([id, v]) => [v.key as string, id]));
  const built = stopsInput({ ...a, known, index: stored.index });
  const byId = new Map((stored.llm.stopPlaces ?? []).map((p) => [p.id, p]));
  for (const p of built.stopPlaces) byId.set(p.id, p);
  const num = (id: string) => Number(id.slice(1)) || 0;
  const stopPlaces = [...byId.values()].sort((x, y) => num(x.id) - num(y.id));
  const llm = { ...stored.llm, trip: { ...stored.llm.trip, ...(a.rows?.length ? { stops: a.rows } : {}) } };
  if (stopPlaces.length) llm.stopPlaces = stopPlaces;
  return {
    ...stored,
    llm: JSON.parse(JSON.stringify(llm)) as PlanInputStored["llm"],
    index: { ...stored.index, ...built.index },
    ...(a.points && Object.keys(a.points).length ? { stopPoints: { ...stored.stopPoints, ...a.points } } : {}),
  };
}

/** Stops of a stored input that need a new lookup: nothing usable (`s` error/skipped) or a failed restaurants/cafés block. */
export function stopsToRetry(stored: Pick<PlanInputStored, "llm" | "stopPoints">, scopeDays: readonly number[]): string[] {
  const rows = stored.llm.trip?.stops ?? [];
  return (stored.llm.stopPlaces ?? [])
    .filter((p) => stored.stopPoints?.[p.id])
    .filter((p) => p.s === "error" || p.s === "skipped" || failedStatus(p.restaurants?.s) || failedStatus(p.cafes?.s))
    .filter((p) => !scopeDays.length || rows.some((r) => r.at === p.id && scopeDays.includes(r.day)))
    .map((p) => p.id);
}
