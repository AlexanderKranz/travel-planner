/** Shared builders for plan unit tests (not imported by app code). */
import type { LlmDay, LlmPlan, PlanHeader, PlanPlace } from "@/lib/domain/plan";
import type { PlanInputStored } from "./input";

export const place = (name: string, km = 1): PlanPlace => ({
  name, category: "leisure=golf_course", lat: 36.5, lon: -4.9, distanceKm: km, osmUrl: "https://www.openstreetmap.org/way/1",
  source: "osm", fetchedAt: "2026-10-01T00:00:00.000Z",
});

export function storedFor(days: number, start: string | null = "2038-03-13"): PlanInputStored {
  const dayList = Array.from({ length: days }, (_, i) => {
    const date = start ? new Date(Date.parse(start) + i * 86_400_000).toISOString().slice(0, 10) : undefined;
    return date ? { n: i + 1, date } : { n: i + 1 };
  });
  return {
    llm: { v: 1, lang: "de", trip: { dest: "Costa del Sol", kind: "region", days, flights: true }, dayList, places: [], noSource: [] },
    index: { p1: { key: "way/1", place: place("Aloha") }, p2: { key: "way/2", place: place("Brisas") }, p3: { key: "node/3", place: place("Cala") } },
  };
}

export const header = (days: number): PlanHeader => ({
  title: "Golf", destination: "Costa del Sol", timing: { kind: "date", startDate: "2038-03-13", endDate: "2038-03-17" },
  lengthDays: days, group: null, purposeName: null, generatedAt: "2026-10-28T00:00:00.000Z", model: "claude-sonnet-5-5",
  basis: { tripUpdatedAt: "x", groupUpdatedAt: null, purposeUpdatedAt: null },
});

export const llmDay = (n: number, over: Partial<LlmDay> = {}): LlmDay => ({
  n, title: `Tag ${n}`,
  stops: [{ place: "Marbella", acts: [{ at: "09:00", kind: "sport", text: `Runde ${n}`, ref: n % 2 ? "p1" : "p2" }] }],
  ...over,
});

export const llmPlan = (days: number, over: Partial<LlmPlan> = {}): LlmPlan => ({
  summary: "Golf.", days: Array.from({ length: days }, (_, i) => llmDay(i + 1)),
  notes: [{ kind: "tip", text: "Sonnencreme" }], open: [{ text: "Startzeiten buchen", day: 2 }], packing: ["Schläger"], ...over,
});
