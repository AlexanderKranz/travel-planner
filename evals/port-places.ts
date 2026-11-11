/**
 * Port-places evals (docs/specs/port-places.md section 9): the cruise fixture's stops, recorded geocoding and recorded
 * lookups replayed as the data layer would return them. No network. Imports server-only parsers: test files must
 * `vi.mock("server-only", () => ({}))`.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GeoPlace } from "@/lib/domain/geo";
import type { PlaceGroup, ResolvedStop, StopFacts } from "@/lib/domain/facts";
import { dayOfDate, type TripStop } from "@/lib/domain/trip-stops";
import type { TripPurpose } from "@/lib/domain/purpose";
import { toRestaurants } from "@/lib/facts/cuisine";
import { radiusForInterest, sourceFor } from "@/lib/facts/interest-sources";
import { rankCandidates } from "@/lib/facts/places";
import { parseElements } from "@/lib/integrations/overpass";
import type { GeocodeDeps } from "@/lib/server/discover/resolve-place";
import { stopInterests } from "@/lib/server/facts/stops";
import { EVAL_FETCHED_AT, EVAL_TODAY, FIXTURES, buildEvalInput, evalPurpose, evalTrip, type EvalStopContext, type ScheduleEntry } from "./build-input";
import { readRecording } from "./recorded";
import { tripStops } from "@/lib/domain/trip-stops";
import type { LlmPatch, LlmPlan, PlanFeedback, PurposeTags } from "@/lib/domain/plan";
import { applyPatch } from "@/lib/plan/patch";
import type { PlanInputStored } from "@/lib/plan/input";
import { extendInputWithStops, stopPointsOf, stopRows } from "@/lib/plan/stops-input";
import { MODEL_PLAN } from "@/lib/domain/ai";
import { assemblePlan } from "@/lib/plan/assemble";
import { RECORDED_GENERATED_AT, evaluateGenerate } from "./evaluate";
import { genericChecks, rawRefs, type CheckResult } from "./checks";
import { portPatchChecks, stopFailureChecks, stopGenerateChecks } from "./stop-checks";
import type { Trip } from "@/lib/domain/trip";
import { resolveStopPlaces } from "@/lib/server/facts/stops";

/** Distinct place names of the cruise fixture's schedule, in order. */
export const STOP_NAMES = ["Passau", "Wien", "Dürnstein", "Melk", "Linz"] as const;

type Raw = { elements: unknown[] } | null;
export type StopRecording = {
  recordedAt: string;
  source: string;
  /** Open-Meteo search results per typed name and language. */
  geocode: Record<string, { en?: GeoPlace[]; de?: GeoPlace[] }>;
  /** Overpass answers (nearest elements) around each stop's resolved point; null = the query failed when recorded. */
  lookups: Record<string, { point: { lat: number; lon: number; geoId: number }; name: string; restaurants?: Raw; family_activities?: Raw; general?: Raw }>;
};

export const STOP_RECORDING_PATH = join(dirname(fileURLToPath(import.meta.url)), "recorded", "cruise.stoplookups.json");
export const readStopRecording = (): StopRecording | null => (existsSync(STOP_RECORDING_PATH) ? (JSON.parse(readFileSync(STOP_RECORDING_PATH, "utf8")) as StopRecording) : null);

/**
 * The fixture's `fixedSchedule` as trip stops (the confirmed variant of itinerary-upload section 9): day from the date,
 * `arr`/`dep` only when they are clock times, "morning" as the note "Ankunft morgens".
 * `cc` is what the AI extraction would set for the Danube ports.
 */
export function scheduleStops(schedule: readonly ScheduleEntry[], startDate: string, cc = "AT"): TripStop[] {
  const hhmm = (s: string | undefined) => (s && /^\d\d:\d\d$/.test(s) ? s : undefined);
  return schedule.map((e) => {
    const stop: TripStop = { day: dayOfDate(startDate, e.date), place: e.place, ...(e.place === "Passau" ? { cc: "DE" } : { cc }) };
    const arr = hhmm(e.arrive);
    const dep = hhmm(e.depart);
    if (arr) stop.arr = arr;
    if (dep) stop.dep = dep;
    if (e.arrive === "morning") stop.note = "Ankunft morgens";
    return stop;
  });
}

/** The recorded Open-Meteo answers as the geocoding calls of `resolvePlaceName`. */
export function replayGeocode(rec: StopRecording): GeocodeDeps {
  return {
    geocode: async (name, lang) => {
      const hit = Object.entries(rec.geocode).find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
      return { ok: true, data: (lang === "en" || lang === "de" ? hit?.[lang] : undefined) ?? [], fetchedAt: EVAL_FETCHED_AT, stale: false, cache: "hit" };
    },
    placeById: async () => null,
  };
}

/**
 * Recorded lookups of every looked-up stop as the data layer returns them: restaurants (nearest pool), and the stop's
 * interests (`stopInterests`: the first two with an OSM source). A missing or failed recording is an `error`.
 */
export function replayStopFacts(rec: StopRecording, resolved: readonly ResolvedStop[], purpose: TripPurpose | null, failing: readonly string[] = []): StopFacts[] {
  const keys = stopInterests(purpose);
  return resolved.map((stop): StopFacts => {
    if (stop.role !== "stop" || stop.status !== "ok" || !stop.point) return { stop, places: [] };
    const look = Object.values(rec.lookups).find((l) => l.point.geoId === stop.point!.geoId);
    const anchor = { lat: Number(stop.point.lat.toFixed(3)), lon: Number(stop.point.lon.toFixed(3)) };
    const failed = failing.includes(stop.name) || failing.includes(stop.id);
    const places = keys.map((interest): PlaceGroup => {
      const src = sourceFor(interest);
      const raw = (look as Record<string, Raw> | undefined)?.[interest];
      if (src.source !== "osm" || failed || !raw) return { interest, status: "error" };
      const candidates = rankCandidates(parseElements(raw), src.filters, anchor, src.exclude, radiusForInterest(interest, 15), { markOpenAir: true });
      return candidates.length
        ? { interest, status: "ok", candidates, fetchedAt: EVAL_FETCHED_AT, stale: false }
        : { interest, status: "empty", fetchedAt: EVAL_FETCHED_AT, stale: false };
    });
    if (failed || !look?.restaurants) return { stop, places, restaurants: { status: "error", restaurants: [] } };
    const list = toRestaurants(parseElements(look.restaurants), anchor, 2.5)
      .sort((x, y) => x.distanceKm - y.distanceKm || x.name.localeCompare(y.name))
      .slice(0, 150);
    return { stop, places, restaurants: { status: list.length ? "ok" : "empty", restaurants: list, radiusKm: 2.5, fetchedAt: EVAL_FETCHED_AT } };
  });
}

export type StopVariant = "notes" | "confirmed";

/**
 * The cruise fixture with stops, both ways (section 9): `notes` = stops derived from `scheduleNotes` (the notes stay on
 * the trip; the derivation result is the fixture schedule until the extraction parser lands), `confirmed` = `trips.stops`
 * from `fixedSchedule` (no notes). Resolved by the real code against the recorded geocoding; `failing` = stops (name or id)
 * whose lookups count as failed (the failure case). null when the lookups were not recorded.
 */
export async function evalStopContext(variant: StopVariant, opts: { failing?: readonly string[]; tags?: PurposeTags | null } = {}): Promise<EvalStopContext | null> {
  const rec = readStopRecording();
  const f = FIXTURES.cruise;
  if (!rec || !f.fixedSchedule) return null;
  const rows = scheduleStops(f.fixedSchedule, f.trip.startDate);
  const plain = evalTrip("cruise");
  const trip: Trip = variant === "confirmed" ? { ...plain, notes: undefined, stops: rows } : plain;
  const stops = tripStops(trip, variant === "notes" ? { notes: plain.notes ?? "", stops: rows } : null);
  const resolved = await resolveStopPlaces(trip, stops, { userId: "eval", locale: f.locale, today: EVAL_TODAY }, replayGeocode(rec));
  const tags = opts.tags ?? readRecording<PurposeTags>("cruise", "tags")?.output ?? null;
  return { trip, stops, resolved, facts: replayStopFacts(rec, resolved, evalPurpose("cruise", tags), opts.failing) };
}

/** The Generate checks of a cruise with stops (assembly with both guards, then `stopGenerateChecks`); the model output is `llm`. */
export async function evaluateStopGenerate(variant: StopVariant, llm: LlmPlan, opts: { failing?: readonly string[] } = {}) {
  const ctx = await evalStopContext(variant, opts);
  if (!ctx) return { results: [{ name: "stop lookups recorded", ok: false, detail: "run npm run evals:port-places" }] as CheckResult[] };
  const tags = readRecording<PurposeTags>("cruise", "tags")?.output ?? null;
  const built = buildEvalInput("cruise", tags, undefined, ctx);
  const res = assemblePlan({ llm, stored: built.stored, header: { ...built.header, generatedAt: RECORDED_GENERATED_AT, model: MODEL_PLAN }, digest: built.digest, locale: FIXTURES.cruise.locale });
  if (!res.ok) return { built, results: [{ name: "assemble", ok: false, detail: res.reason }] as CheckResult[] };
  const startDate = built.trip.timing.kind === "date" ? built.trip.timing.startDate : undefined;
  const results: CheckResult[] = [
    { name: "assemble", ok: true },
    ...genericChecks({ plan: res.plan, stored: built.stored, rawRefs: rawRefs(llm.days), issues: res.issues, startDate }),
    ...stopGenerateChecks({ llm, plan: res.plan, stored: built.stored, issues: res.issues }),
  ];
  const failedStop = (opts.failing ?? [])[0];
  if (failedStop) {
    const s = ctx.resolved.find((r) => r.name === failedStop);
    if (s) results.push(...stopFailureChecks(res.plan, built.stored, { id: s.id, name: s.name, day: s.days[0] }));
  }
  return { built, plan: res.plan, results };
}

/** The patch request of the spec: concrete restaurants for the days on land in other cities. */
export const PORT_PATCH_FEEDBACK: PlanFeedback = { chips: [], days: [], text: "konkrete Restaurantvorschläge für die Tage an Land in anderen Städten" };

/** The port days of the cruise fixture and the stop each belongs to (Wien s1, Dürnstein s2, Melk s3, Linz s4). */
export const PORT_DAYS = [{ day: 2, stop: "s1" }, { day: 3, stop: "s2" }, { day: 3, stop: "s3" }, { day: 4, stop: "s4" }];

/**
 * The patch eval on the plan-7 base (the recorded cruise generation, no `trip.stops`): the input is upgraded with the
 * stops (recorded lookups), `first` is the model's answer to PORT_PATCH_FEEDBACK. Checks: upgraded input, one call, days
 * 2-4 gain restaurant refs of their stops.
 */
export async function evaluatePortPatch(baseLlm: LlmPlan, first: LlmPatch) {
  const tags = readRecording<PurposeTags>("cruise", "tags")?.output ?? null;
  const base = evaluateGenerate("cruise", tags, baseLlm);
  const ctx = await evalStopContext("confirmed");
  if (!base.plan || !ctx) return { results: [{ name: "base plan and stop lookups", ok: false, detail: "missing" }] as CheckResult[] };
  const upgraded = upgradedInput(base.built.stored, ctx);
  const applied = applyPatch({ base: base.plan, patch: first, stored: upgraded, scope: [] });
  if (!applied.ok) return { results: [{ name: "applyPatch", ok: false, detail: applied.reason }] as CheckResult[] };
  return { upgraded, plan: applied.plan, results: [{ name: "applyPatch", ok: true } as CheckResult, ...portPatchChecks({ upgraded, first, base: base.plan, next: applied.plan, portDays: PORT_DAYS })] };
}

/** The base input of a patch after `prepareStopsForPatch`: the stops added with their recorded lookups. */
export function upgradedInput(stored: PlanInputStored, ctx: EvalStopContext): PlanInputStored {
  return extendInputWithStops(stored, {
    rows: stopRows(ctx.stops, ctx.resolved),
    points: stopPointsOf(ctx.resolved),
    facts: ctx.facts,
    lang: FIXTURES.cruise.locale,
    cuisine: stored.llm.restaurants?.ask,
    countryCode: FIXTURES.cruise.trip.anchor.countryCode,
  });
}
