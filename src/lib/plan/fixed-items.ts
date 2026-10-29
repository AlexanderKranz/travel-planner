import type { ItemCategory, ItemStatus, SharedItem } from "@/lib/domain/items";
import type { PlanActivity, PlanDay, PlanFlights, PlanStop } from "@/lib/domain/plan";

/**
 * Timed trip items in the plan (spec docs/specs/timed-items.md). Pure.
 * A fixed item is an item with status booked/planned, a day within the trip and a start time [D3].
 * Options and rejected items stay in the costs only.
 */
export type FixedItem = {
  id: string;
  day: number;
  from: string;
  to?: string;
  category: ItemCategory;
  title: string;
  status: Extract<ItemStatus, "booked" | "planned">;
};

/** Compact LLM input slot: no ids, no status, no title for flights (flight numbers stay out of the prompt). */
export type FixedSlot = { day: number; from: string; to?: string; cat: ItemCategory; title?: string };

export const FIXED_STATUSES = ["booked", "planned"] as const;
export const SLOT_TITLE_MAX = 60;

const isFixedStatus = (s: ItemStatus): s is FixedItem["status"] => s === "booked" || s === "planned";

/** Fixed items of a trip, sorted by day, start time, then title. */
export function fixedItemsOf(
  items: Pick<SharedItem, "id" | "day" | "startTime" | "endTime" | "category" | "title" | "status">[],
  lengthDays: number,
): FixedItem[] {
  const out: FixedItem[] = [];
  for (const i of items) {
    if (!isFixedStatus(i.status) || i.day === null || i.day < 1 || i.day > lengthDays || !i.startTime) continue;
    const f: FixedItem = { id: i.id, day: i.day, from: i.startTime, category: i.category, title: i.title, status: i.status };
    if (i.endTime) f.to = i.endTime;
    out.push(f);
  }
  return out.sort((a, b) => a.day - b.day || a.from.localeCompare(b.from) || a.title.localeCompare(b.title));
}

/** Fixed items → `fixed` of the LLM input (spec [D4]). Undefined when there are none. */
export function fixedSlots(fixed: FixedItem[]): FixedSlot[] | undefined {
  if (!fixed.length) return undefined;
  return fixed.map((f) => {
    const s: FixedSlot = { day: f.day, from: f.from, cat: f.category };
    if (f.to) s.to = f.to;
    if (f.category !== "flight") s.title = f.title.slice(0, SLOT_TITLE_MAX);
    return s;
  });
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** [start, end) in minutes of the day. An end before the start runs to midnight; no end = 1 minute. */
export function slotRange(s: { from: string; to?: string }): [number, number] {
  const a = toMin(s.from);
  if (!s.to) return [a, a + 1];
  const b = toMin(s.to);
  return [a, b > a ? b : 24 * 60];
}

/** Does a timed activity overlap a fixed slot? Activities without `at` never overlap; `at` alone is a point. */
export function overlapsSlot(act: Pick<PlanActivity, "at" | "until">, slot: { from: string; to?: string }): boolean {
  if (!act.at) return false;
  const a = toMin(act.at);
  const b = act.until && toMin(act.until) > a ? toMin(act.until) : a + 1;
  const [s, e] = slotRange(slot);
  return a < e && s < b;
}

/**
 * Drops timed activities that overlap a fixed slot of that day (code guard, [D6]). Returns the day unchanged
 * (same object) when nothing overlaps.
 */
export function dropOverlaps(day: PlanDay, slots: { day: number; from: string; to?: string }[] | undefined): { day: PlanDay; dropped: number } {
  const mine = (slots ?? []).filter((s) => s.day === day.n);
  if (!mine.length) return { day, dropped: 0 };
  let dropped = 0;
  const stops = day.stops.map((st) => {
    const acts = st.acts.filter((a) => {
      const hit = mine.some((s) => overlapsSlot(a, s));
      if (hit) dropped += 1;
      return !hit;
    });
    return acts.length === st.acts.length ? st : { ...st, acts };
  });
  return dropped ? { day: { ...day, stops }, dropped } : { day, dropped: 0 };
}

// --- Rendering: merge fixed items into the rows of a day ---

export type DayRow = { kind: "act"; act: PlanActivity } | { kind: "fixed"; item: FixedItem };
export type StopRows = { stop: PlanStop; rows: DayRow[] };

/** Sort time of each activity: its `at`, else the next timed act of the stop, else the previous, else the window. */
function effectiveTimes(stop: PlanStop): (string | null)[] {
  const ats = stop.acts.map((a) => a.at ?? null);
  return ats.map((t, i) => {
    if (t) return t;
    const next = ats.slice(i + 1).find((x) => x);
    if (next) return next;
    const prev = ats.slice(0, i).reverse().find((x) => x);
    return prev ?? stop.from ?? stop.to ?? null;
  });
}

/**
 * Activities and fixed items of one day in time order (render time, [D7]). Each fixed item goes before the first
 * activity (across stops, in plan order) whose sort time is at or after its start; otherwise to the end of the
 * last stop. Activities keep their stop and order.
 */
export function mergeDayRows(day: PlanDay, fixed: FixedItem[]): StopRows[] {
  const mine = fixed.filter((f) => f.day === day.n).sort((a, b) => a.from.localeCompare(b.from));
  const out: StopRows[] = day.stops.map((stop) => ({ stop, rows: [] }));
  let k = 0;
  day.stops.forEach((stop, si) => {
    const times = effectiveTimes(stop);
    stop.acts.forEach((act, ai) => {
      const t = times[ai];
      while (k < mine.length && t !== null && t >= mine[k].from) out[si].rows.push({ kind: "fixed", item: mine[k++] });
      out[si].rows.push({ kind: "act", act });
    });
  });
  const last = out[out.length - 1];
  while (k < mine.length && last) last.rows.push({ kind: "fixed", item: mine[k++] });
  return out;
}

/**
 * Items changed after this plan version ([D8]): a timed item (day + start time) whose updatedAt is later than the
 * version time. Deleted items leave no trace and are not detected (their rows disappear from the view anyway).
 */
export function itemsChangedSince(
  items: (Pick<SharedItem, "day" | "startTime"> & { updatedAt?: string })[],
  versionAt: string,
): boolean {
  const t = Date.parse(versionAt);
  return items.some((i) => i.day !== null && !!i.startTime && !!i.updatedAt && Date.parse(i.updatedAt) > t);
}

// --- Flights list → item ---

type Leg = Pick<PlanFlights["legs"][number], "dir" | "number" | "from" | "to" | "dep" | "arr" | "date">;

/** Does a free-text title name this flight number ("LH 826", "lh826", "Flug LH 826 FRA-CPH"; not "LH 8260")? */
export function titleHasFlight(title: string, number: string): boolean {
  const m = /^([A-Z0-9]{2})\s*(\d{1,4}[A-Z]?)$/i.exec(number.trim());
  if (!m) return title.toUpperCase().includes(number.trim().toUpperCase());
  return new RegExp(`(^|[^A-Z0-9])${m[1]}\\s?0*${m[2].replace(/^0+/, "")}(?![0-9])`, "i").test(title);
}

/** Item title for a leg, e.g. "LH 826 FRA → CPH". */
export function flightTitle(leg: Pick<Leg, "number" | "from" | "to">): string {
  return `${leg.number} ${leg.from} → ${leg.to}`;
}

/** Trip day of a leg: the day of its date for dated trips, else outbound = 1 and return = last day. */
export function legDay(leg: Pick<Leg, "dir" | "date">, lengthDays: number, startDate: string | null): number {
  const last = Math.max(1, Math.min(60, lengthDays));
  if (startDate) {
    const n = Math.round((Date.parse(`${leg.date}T12:00:00Z`) - Date.parse(`${startDate}T12:00:00Z`)) / 86_400_000) + 1;
    if (Number.isInteger(n) && n >= 1 && n <= last) return n;
  }
  return leg.dir === "out" ? 1 : last;
}

export type FlightPrefill = {
  title: string;
  category: "flight";
  day: number;
  ref: null;
  startTime: string;
  endTime: string;
};

/** Item form prefill for a verified leg: category flight, title, trip day, dep → start, arr → end. */
export function flightPrefill(leg: Leg, lengthDays: number, startDate: string | null): FlightPrefill {
  return {
    title: flightTitle(leg),
    category: "flight",
    day: legDay(leg, lengthDays, startDate),
    ref: null,
    startTime: leg.dep,
    endTime: leg.arr,
  };
}

/**
 * The item that already holds this leg: category flight, same flight number in the title, same trip day
 * (rejected items do not count). Returns the first match.
 */
export function itemForLeg<T extends Pick<SharedItem, "category" | "title" | "day" | "status">>(
  leg: Leg,
  items: T[],
  lengthDays: number,
  startDate: string | null,
): T | undefined {
  const day = legDay(leg, lengthDays, startDate);
  return items.find(
    (i) =>
      i.category === "flight" &&
      i.status !== "rejected" &&
      i.day === day &&
      titleHasFlight(i.title, leg.number),
  );
}

/** "07:50–10:40", "23:10–01:20 +1" (ends the next day), "10:00" (no end); "" without a start. */
export function timeRange(from: string | null | undefined, to?: string | null): string {
  if (!from) return "";
  if (!to) return from;
  return `${from}–${to}${to < from ? " +1" : ""}`;
}
