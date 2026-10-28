/**
 * AeroDataBox via RapidAPI (Basic plan: 400 units + 1 600 requests per month, 1 request/s, non-commercial,
 * attribution required). Server-only; key from AERODATABOX_API_KEY.
 * Docs: https://doc.aerodatabox.com (OpenAPI https://doc.aerodatabox.com/docs/openapi-rapidapi-v1.json),
 * pricing https://aerodatabox.com/pricing. Checked 2026-10-28.
 * Base URL https://aerodatabox.p.rapidapi.com, headers x-rapidapi-key + x-rapidapi-host.
 * Quota headers: x-ratelimit-api-units-remaining. Failed requests (400) still cost units.
 * Tier costs (verified live): routes/daily 6, FIDS 2, flights/number dates 2.
 * Callers wrap these in `cached()`; the quota guard runs here, so cache hits never check it.
 */
import "server-only";
import { assertUnits } from "@/lib/server/flights-quota";
import type { FetchOutcome } from "@/lib/server/api-cache";
import { HttpError } from "./http";
import {
  normalizeFids,
  normalizeFlightDates,
  normalizeRoutes,
  type FidsLeg,
  type RouteStat,
} from "./aerodatabox-normalize";

export const AERODATABOX_HOST = "aerodatabox.p.rapidapi.com";
export const UNITS = { routes: 6, fids: 2, dates: 2 } as const;
export const MIN_INTERVAL_MS = 1100;
const REQUEST_TIMEOUT_MS = 15_000;

/** HTTP failure that carries the units AeroDataBox charged anyway; cached() logs them. */
export class AeroDataBoxHttpError extends HttpError {
  readonly units: number;
  readonly quotaRemaining?: number;
  constructor(status: number, units: number, quotaRemaining?: number) {
    super(status);
    this.units = units;
    this.quotaRemaining = quotaRemaining;
  }
}

/** Rejected before any call (no units spent). */
export class FlightsRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlightsRequestError";
  }
}

const IATA = /^[A-Z]{3}$/;
const FLIGHT_NUMBER = /^[A-Z0-9]{2}\d{1,4}[A-Z]?$/;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86_400_000);
}

/** Pure request validation (spec 1.3). `today` = ISO date. Throws FlightsRequestError. */
export function validateRequest(
  r: { iata?: string; number?: string; dates: string[]; windowHours?: number },
  today: string,
): void {
  if (r.iata !== undefined && !IATA.test(r.iata)) throw new FlightsRequestError("invalid IATA");
  if (r.number !== undefined && !FLIGHT_NUMBER.test(r.number)) throw new FlightsRequestError("invalid flight number");
  for (const d of r.dates) {
    if (!ISO.test(d) || Number.isNaN(Date.parse(d))) throw new FlightsRequestError("invalid date");
    const diff = dayDiff(d, today);
    if (diff < -365 || diff > 365) throw new FlightsRequestError("date outside [-365, +365] days");
  }
  if (r.windowHours !== undefined && r.windowHours > 12) throw new FlightsRequestError("window over 12 h");
}

/** Module-level chain: min 1 100 ms between request starts (1 req/s plan limit). */
let chain: Promise<unknown> = Promise.resolve();
let lastStart = 0;
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastStart + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    return task();
  });
  chain = run.catch(() => undefined);
  return run;
}

export function aeroDataBoxEnabled(): boolean {
  return Boolean(process.env.AERODATABOX_API_KEY?.trim());
}

function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

async function request(path: string, units: number): Promise<{ body: unknown; status: number; latencyMs: number; quotaRemaining?: number }> {
  const key = process.env.AERODATABOX_API_KEY?.trim();
  if (!key) throw new FlightsRequestError("AERODATABOX_API_KEY missing");
  return serialized(async () => {
    await assertUnits(units);
    const started = Date.now();
    const res = await fetch(`https://${AERODATABOX_HOST}${path}`, {
      method: "GET",
      headers: { "x-rapidapi-key": key, "x-rapidapi-host": AERODATABOX_HOST, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    }).catch((err: unknown) => {
      if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
        const t = new Error("Timeout");
        t.name = "TimeoutError";
        throw t;
      }
      throw err;
    });
    const latencyMs = Date.now() - started;
    const header = Number.parseInt(res.headers.get("x-ratelimit-api-units-remaining") ?? "", 10);
    const quotaRemaining = Number.isFinite(header) ? header : undefined;
    if (!res.ok) throw new AeroDataBoxHttpError(res.status, units, quotaRemaining);
    return { body: (await res.json()) as unknown, status: res.status, latencyMs, quotaRemaining };
  });
}

function outcome<T>(data: T, r: { status: number; latencyMs: number; quotaRemaining?: number }, units: number): FetchOutcome<T> {
  return { data, status: r.status, latencyMs: r.latencyMs, units, quotaRemaining: r.quotaRemaining };
}

/** Destinations served from airport `a` in the 7 days before `date` (6 units). */
export async function fetchRoutesDaily(a: string, date: string): Promise<FetchOutcome<RouteStat[]>> {
  validateRequest({ iata: a, dates: [date] }, todayUtc());
  const r = await request(`/airports/iata/${a}/stats/routes/daily/${date}`, UNITS.routes);
  return outcome(normalizeRoutes(r.body), r, UNITS.routes);
}

/** All departures of airport `a` in the am (00:00-11:59) or pm (12:00-23:59) local window of `date` (2 units). */
export async function fetchDepartures(a: string, date: string, w: "am" | "pm"): Promise<FetchOutcome<FidsLeg[]>> {
  validateRequest({ iata: a, dates: [date], windowHours: 12 }, todayUtc());
  const [from, to] = w === "am" ? ["00:00", "11:59"] : ["12:00", "23:59"];
  const q = "direction=Departure&withLeg=true&withCancelled=false&withCodeshared=false&withCargo=false&withPrivate=false&withLocation=false";
  const r = await request(`/flights/airports/iata/${a}/${date}T${from}/${date}T${to}?${q}`, UNITS.fids);
  return outcome(normalizeFids(r.body), r, UNITS.fids);
}

/** ISO dates within month `m` ("YYYY-MM") on which flight `number` ("LH1148") is scheduled (2 units). */
export async function fetchFlightDates(number: string, month: string): Promise<FetchOutcome<string[]>> {
  const compact = number.replace(/\s+/g, "").toUpperCase();
  if (!/^\d{4}-\d{2}$/.test(month)) throw new FlightsRequestError("invalid month");
  const [y, mo] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const from = `${month}-01`;
  const to = `${month}-${String(last).padStart(2, "0")}`;
  validateRequest({ number: compact, dates: [from, to] }, todayUtc());
  const r = await request(`/flights/number/${compact}/dates/${from}/${to}`, UNITS.dates);
  return outcome(normalizeFlightDates(r.body), r, UNITS.dates);
}
