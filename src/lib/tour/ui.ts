/**
 * Pure helpers of the city tour UI (docs/specs/city-tour.md sections 2, 3.2, 7). Client-safe: no server imports, no
 * UI strings (the components translate the keys and values returned here).
 */
import {
  legKey,
  MAX_TOUR_PLACES,
  ROUTE_OPTIONS_BY_MODE,
  routeAllowed,
  type LegSetting,
  type RouteOption,
  type TourDraft,
  type TourInput,
  type TourLeg,
  type TourMode,
  type TourPoint,
  type TourResult,
  type TourSight,
} from "@/lib/domain/tour";

/** A point in the form: what the server handed out (`ref` for new points) plus what the list and the map show. */
export type FormPoint = {
  key: string;
  /** Signed reference of a suggestion or search result; absent for points already stored in the tour. */
  ref?: string;
  name: string;
  lat: number;
  lon: number;
  source?: TourPoint["source"];
  cat?: string;
  /** Own dwell estimate in minutes; absent = tour default. */
  dwellMin?: number;
};

export type EndKind = "none" | "start" | "other";
export type TourOrder = "optimize" | "keep";

/** The whole form state. Text fields stay strings (empty = not set) until `toDraft`. */
export type TourForm = {
  title: string;
  city: FormPoint | null;
  places: FormPoint[];
  start: FormPoint | null;
  endKind: EndKind;
  end: FormPoint | null;
  order: TourOrder;
  mode: TourMode;
  route: RouteOption;
  legOverrides: Record<string, LegSetting>;
  date: string;
  startTime: string;
  endBy: string;
  minMin: string;
  maxMin: string;
  dwellDefaultMin: number;
};

export const DEFAULT_DWELL_MIN = 30;

export function emptyForm(): TourForm {
  return {
    title: "",
    city: null,
    places: [],
    start: null,
    endKind: "none",
    end: null,
    order: "optimize",
    mode: "foot",
    route: "fastest",
    legOverrides: {},
    date: "",
    startTime: "",
    endBy: "",
    minMin: "",
    maxMin: "",
    dwellDefaultMin: DEFAULT_DWELL_MIN,
  };
}

const fromPoint = (p: TourPoint): FormPoint => {
  const out: FormPoint = { key: p.key, name: p.name, lat: p.lat, lon: p.lon, source: p.source };
  if (p.cat) out.cat = p.cat;
  if (p.dwellMin !== undefined) out.dwellMin = p.dwellMin;
  return out;
};

/** Stored tour → form (points without `ref`: the server knows them already). */
export function formFromInput(input: TourInput, title: string | null): TourForm {
  const endIsStart = input.end === "start" || (typeof input.end === "object" && input.end.key === input.start?.key);
  return {
    title: title ?? "",
    city: input.city ? fromPoint(input.city) : null,
    places: input.places.map(fromPoint),
    start: input.start ? fromPoint(input.start) : null,
    endKind: input.end === undefined ? "none" : endIsStart ? "start" : "other",
    end: typeof input.end === "object" && !endIsStart ? fromPoint(input.end) : null,
    order: input.order,
    mode: input.mode,
    route: input.route,
    legOverrides: { ...(input.legOverrides ?? {}) },
    date: input.date ?? "",
    startTime: input.startTime ?? "",
    endBy: input.endBy ?? "",
    minMin: input.minMin === undefined ? "" : String(input.minMin),
    maxMin: input.maxMin === undefined ? "" : String(input.maxMin),
    dwellDefaultMin: input.dwellDefaultMin,
  };
}

const draftPoint = (p: FormPoint, withDwell: boolean) => ({
  key: p.key,
  ...(p.ref ? { ref: p.ref } : {}),
  ...(withDwell && p.dwellMin !== undefined ? { dwellMin: p.dwellMin } : {}),
});

const intOrUndefined = (s: string): number | undefined => {
  if (!s.trim()) return undefined;
  const n = Number(s);
  return Number.isInteger(n) ? n : undefined;
};

/**
 * Form → `TourDraft` for createTour / updateTour. Overrides are kept only for place pairs that still exist among the
 * tour's points (the server prunes the rest by order anyway); `endBy` only with a start time.
 */
export function toDraft(f: TourForm): TourDraft {
  const keys = new Set([...f.places.map((p) => p.key), f.start?.key, f.end?.key].filter(Boolean) as string[]);
  const overrides = Object.fromEntries(
    Object.entries(f.legOverrides).filter(([k]) => {
      const [a, b] = k.split(">");
      return keys.has(a) && keys.has(b);
    }),
  );
  const draft: TourDraft = {
    places: f.places.map((p) => draftPoint(p, true)),
    order: f.order,
    mode: f.mode,
    route: routeAllowed(f.mode, f.route) ? f.route : "fastest",
    dwellDefaultMin: f.dwellDefaultMin,
  };
  if (f.title.trim()) draft.title = f.title.trim();
  if (f.city) draft.city = draftPoint(f.city, false);
  if (f.start) draft.start = draftPoint(f.start, false);
  if (f.endKind === "start" && f.start) draft.end = "start";
  else if (f.endKind === "other" && f.end) draft.end = draftPoint(f.end, false);
  if (Object.keys(overrides).length) draft.legOverrides = overrides;
  if (f.date) draft.date = f.date;
  if (f.startTime) draft.startTime = f.startTime;
  if (f.startTime && f.endBy) draft.endBy = f.endBy;
  const minMin = intOrUndefined(f.minMin);
  const maxMin = intOrUndefined(f.maxMin);
  if (minMin !== undefined) draft.minMin = minMin;
  if (maxMin !== undefined) draft.maxMin = maxMin;
  return draft;
}

/** Stable JSON (sorted keys, no refs): equal for two drafts that describe the same tour. */
export function draftSignature(d: TourDraft): string {
  const norm = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([k, x]) => x !== undefined && k !== "ref")
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, norm(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(norm(d));
}

/**
 * Whether the shown result no longer matches the form (spec 2.1 step 4): there is no result, the server said the
 * stored result belongs to another input, or the form changed since the last save. Nothing is recomputed by itself.
 */
export function isOutdated(a: { hasResult: boolean; serverOutdated: boolean; savedSignature: string | null; signature: string }): boolean {
  if (!a.hasResult) return true;
  if (a.serverOutdated) return true;
  return a.savedSignature !== a.signature;
}

/** Whether the form can be sent: at least 2 places, at most MAX_TOUR_PLACES, end "other" needs a place. */
export function formReady(f: TourForm): boolean {
  if (f.places.length < 2 || f.places.length > MAX_TOUR_PLACES) return false;
  if (f.endKind === "other" && !f.end) return false;
  if (f.endKind === "start" && !f.start) return false;
  return true;
}

/** Moves item `i` one step up (-1) or down (+1); unchanged at the edges. */
export function moveItem<T>(list: readonly T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || i >= list.length || j < 0 || j >= list.length) return [...list];
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** Whether a point may be added: not yet a place, start or end, and room left. */
export function canAddPlace(f: TourForm, key: string): boolean {
  if (f.places.length >= MAX_TOUR_PLACES) return false;
  return !f.places.some((p) => p.key === key) && f.start?.key !== key && f.end?.key !== key;
}

// --- Dwell and duration choices ---------------------------------------------------------------------------------

/** Dwell choices in minutes (0 to 8 h, spec [T9]). */
export const DWELL_CHOICES = [0, 15, 30, 45, 60, 90, 120, 150, 180, 240, 300, 360, 480] as const;
/** Default dwell choices (the schema allows 0 to 240). */
export const DWELL_DEFAULT_CHOICES = [0, 15, 30, 45, 60, 90, 120, 180, 240] as const;
/** Min/max duration choices in minutes (schema 15 to 1440). */
export const DURATION_CHOICES = [30, 60, 90, 120, 150, 180, 240, 300, 360, 420, 480, 600, 720] as const;

/** Choices that always contain the current value (a stored value outside the list stays selectable). */
export function choicesWith(choices: readonly number[], current: number | undefined): number[] {
  if (current === undefined || choices.includes(current)) return [...choices];
  return [...choices, current].sort((a, b) => a - b);
}

/** Minutes → message key and values: "45 Min." or "2 Std. 5 Min." / "2 Std.". */
export function durationParts(min: number): { key: "durationMin" | "durationH" | "durationHm"; values: { h: number; m: number } } {
  const total = Math.max(0, Math.round(min));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return { key: "durationMin", values: { h, m } };
  return { key: m === 0 ? "durationH" : "durationHm", values: { h, m } };
}

/** "4,2" / "4.2" with at most one decimal (two below 1 km would be false precision for a walk). */
export function formatKm(km: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1, minimumFractionDigits: km < 10 ? 1 : 0 }).format(km);
}

/** Metres rounded for display: 10 m steps below 1 km. */
export function roundMetres(m: number): number {
  return m < 1000 ? Math.max(10, Math.round(m / 10) * 10) : Math.round(m / 100) * 100;
}

// --- Result rows ------------------------------------------------------------------------------------------------

/** Name of every point a result may mention: input points and sights. */
export function pointNames(input: Pick<TourInput, "city" | "places" | "start" | "end">, sights: readonly TourSight[] = []): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of sights) m.set(s.key, s.name);
  const add = (p?: { key: string; name: string }) => p && m.set(p.key, p.name);
  add(input.city);
  input.places.forEach(add);
  add(input.start);
  if (typeof input.end === "object") add(input.end);
  return m;
}

/** Coordinates of every input point by key. */
export function pointCoords(input: Pick<TourInput, "places" | "start" | "end">): Map<string, { lat: number; lon: number }> {
  const m = new Map<string, { lat: number; lon: number }>();
  for (const p of [input.start, ...input.places, typeof input.end === "object" ? input.end : undefined]) {
    if (p) m.set(p.key, { lat: p.lat, lon: p.lon });
  }
  return m;
}

export type StopRow = {
  key: string;
  /** 1-based position in the tour. */
  n: number;
  name: string;
  role: "start" | "place" | "end";
  dwellMin: number;
  arrive?: string;
  leave?: string;
};

export type LegRow = TourLeg & {
  index: number;
  /** Mode or route differs from the tour setting (a per-leg override is in effect). */
  overridden: boolean;
  sights: TourSight[];
};

/**
 * Ordered stops and the legs between them, from a result and the input it was computed for. `times` (arrive/leave
 * per stop of `result.order`) only when the tour has a start time.
 */
export function resultRows(
  input: Pick<TourInput, "city" | "places" | "start" | "end" | "mode" | "route" | "dwellDefaultMin">,
  result: Pick<TourResult, "order" | "legs" | "sights">,
  times: readonly { arrive: string; leave: string }[] | null,
): { stops: StopRow[]; legs: LegRow[] } {
  const names = pointNames(input, result.sights);
  const dwell = new Map(input.places.map((p) => [p.key, p.dwellMin ?? input.dwellDefaultMin]));
  const stops = result.order.map((key, i): StopRow => {
    const role: StopRow["role"] = input.start && i === 0 && key === input.start.key ? "start" : dwell.has(key) ? "place" : "end";
    const row: StopRow = { key, n: i + 1, name: names.get(key) ?? key, role, dwellMin: role === "place" ? (dwell.get(key) ?? 0) : 0 };
    const t = times?.[i];
    if (t) {
      row.arrive = t.arrive;
      row.leave = t.leave;
    }
    return row;
  });
  const legs = result.legs.map((l, index): LegRow => ({
    ...l,
    index,
    overridden: l.mode !== input.mode || l.route !== input.route,
    sights: result.sights.filter((s) => s.leg === index),
  }));
  return { stops, legs };
}

/** Ordered coordinates of a result for the map and the Google link (unknown keys are skipped). */
export function orderedCoords(
  input: Pick<TourInput, "places" | "start" | "end">,
  order: readonly string[],
): { key: string; lat: number; lon: number }[] {
  const c = pointCoords(input);
  return order.flatMap((key) => {
    const p = c.get(key);
    return p ? [{ key, ...p }] : [];
  });
}

// --- Leg sheet ("Ändern") --------------------------------------------------------------------------------------

export type LegSheet = { key: string; from: string; to: string; mode: TourMode; route: RouteOption };

/** Opens the sheet with the leg's current setting (its override, else the tour setting). */
export function openLegSheet(from: string, to: string, f: Pick<TourForm, "legOverrides" | "mode" | "route">): LegSheet {
  const key = legKey(from, to);
  const o = f.legOverrides[key];
  return { key, from, to, mode: o?.mode ?? f.mode, route: o?.route ?? f.route };
}

/** Another mode in the sheet: the route option stays when that mode offers it, else the mode's first option. */
export function sheetMode(s: LegSheet, mode: TourMode): LegSheet {
  return { ...s, mode, route: routeAllowed(mode, s.route) ? s.route : ROUTE_OPTIONS_BY_MODE[mode][0] };
}

/** Applies the sheet: a setting equal to the tour's removes the override (the leg follows the tour again). */
export function applyLegSheet(
  overrides: Readonly<Record<string, LegSetting>>,
  s: LegSheet,
  tour: Pick<TourForm, "mode" | "route">,
): Record<string, LegSetting> {
  const out = { ...overrides };
  if (s.mode === tour.mode && s.route === tour.route) delete out[s.key];
  else out[s.key] = { mode: s.mode, route: s.route };
  return out;
}

/** Tour mode changed: its route option falls back when not offered; overrides stay (they carry their own mode). */
export function withMode(f: TourForm, mode: TourMode): TourForm {
  return { ...f, mode, route: routeAllowed(mode, f.route) ? f.route : ROUTE_OPTIONS_BY_MODE[mode][0] };
}

// --- Over-limit proposals (spec 7) --------------------------------------------------------------------------------

export type Proposal =
  | { kind: "optimize"; totalMin: number }
  | { kind: "dwell"; totalMin: number }
  | { kind: "drop"; key: string; totalMin: number };

/** Applies a proposal to the form. Nothing is applied by itself; the user picks one and recomputes. */
export function applyProposal(f: TourForm, p: Proposal): TourForm {
  switch (p.kind) {
    case "optimize":
      return { ...f, order: "optimize" };
    case "dwell":
      return {
        ...f,
        places: f.places.map((x) => (x.dwellMin !== undefined && x.dwellMin > f.dwellDefaultMin ? { ...x, dwellMin: undefined } : x)),
      };
    case "drop":
      return f.places.length > 2 ? { ...f, places: f.places.filter((x) => x.key !== p.key) } : f;
  }
}

/** Keys named in action issues (`unknown_point` puts the key in `path`). */
export function issueKeys(issues: readonly { path: string }[] | undefined): string[] {
  return [...new Set((issues ?? []).map((i) => i.path))];
}
