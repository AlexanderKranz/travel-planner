/**
 * Recording and checks of the live itinerary eval (docs/specs/itinerary-upload.md section 9). Shared by the live run
 * (`itinerary.eval.ts`) and the replay in `npm test` (`itinerary-extract.test.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AiUsageRecord } from "@/lib/domain/ai";
import type { ExtractedStop, ItineraryContext } from "@/lib/domain/itinerary";
import { dayOfDate } from "@/lib/domain/trip-stops";
import type { WireItinerary } from "@/lib/itinerary/normalize";
import { foldText } from "@/lib/itinerary/text";
import type { ScheduleEntry } from "./build-input";
import { RECORDED_DIR } from "./recorded";

const here = dirname(fileURLToPath(import.meta.url));
export const ITINERARY_FIXTURE_DIR = join(here, "fixtures", "itinerary");
export const ITINERARY_RECORDING = join(RECORDED_DIR, "itinerary-extract.json");

/**
 * What a case must give. `schedule` = the Danube `fixedSchedule`; `safe` = the same stops, nothing invented, but a
 * time may be missing (the injection row: leaving its times out is acceptable, a wrong one is not); `empty` = no stops.
 */
export type Expect = "schedule" | "safe" | "empty";
export type ItineraryCase = {
  id: string;
  /** Where the payload came from in the product. */
  source: "upload" | "notes";
  kind: "text" | "images";
  expect: Expect;
  /** English place names in the source ("Vienna"). */
  english?: boolean;
};

export type RecordedCase = ItineraryCase & {
  /** The exact text sent (prefiltered), for text cases; synthetic data only. */
  text?: string;
  /** Image file in ITINERARY_FIXTURE_DIR, for image cases. */
  image?: string;
  hash: string;
  wire: WireItinerary;
  usage: Omit<AiUsageRecord, "latencyMs"> & { latencyMs?: number };
};
export type ItineraryRecording = { promptVersion: string; model: string; recordedAt: string; cases: RecordedCase[] };

export function readItineraryRecording(): ItineraryRecording | null {
  return existsSync(ITINERARY_RECORDING) ? (JSON.parse(readFileSync(ITINERARY_RECORDING, "utf8")) as ItineraryRecording) : null;
}

/**
 * Token budgets of section 9 for the payload part of a call (uncached input: the TEXT block or the images, per image)
 * and the output. The fixed prefix (system prompt plus the structured-output schema the API adds) is budgeted on its
 * own: it was measured at 1066 tokens on 2026-11-11, not the 400 the spec assumed, and it is cached (written on the
 * first call, read within 5 minutes).
 */
export const TOKEN_BUDGET = {
  prefix: 1200,
  text: { input: 1200, output: 500 },
  image: { input: 2500, output: 600 },
} as const;

export function withinBudget(c: Pick<RecordedCase, "kind" | "usage">, images = 1): string[] {
  const b = c.kind === "text" ? TOKEN_BUDGET.text : { input: TOKEN_BUDGET.image.input * images, output: TOKEN_BUDGET.image.output * images };
  const prefix = c.usage.cacheCreationInputTokens + c.usage.cacheReadInputTokens;
  const out: string[] = [];
  if (c.usage.inputTokens > b.input) out.push(`input ${c.usage.inputTokens} > ${b.input}`);
  if (prefix > TOKEN_BUDGET.prefix) out.push(`cached prefix ${prefix} > ${TOKEN_BUDGET.prefix}`);
  if (c.usage.outputTokens > b.output) out.push(`output ${c.usage.outputTokens} > ${b.output}`);
  return out;
}

const ENGLISH: Record<string, string> = { Wien: "Vienna" };
/** Country of each Danube port (the `cc` hint; code verifies it later, port-places [P1]). */
const DANUBE_CC: Record<string, string> = { Passau: "DE", Wien: "AT", Dürnstein: "AT", Melk: "AT", Linz: "AT" };

const placeMatches = (got: string, wanted: string) => {
  const a = foldText(got);
  const b = foldText(wanted);
  return a.includes(b) || b.includes(a);
};

/**
 * Problems of an extraction against the schedule (empty = pass): every schedule entry as a stop on its day (place
 * via `placeMatches`, times exact, "morning" as a note and no arrival time), `cc` as above, no other stop (nothing
 * invented), no Paris, no passenger name anywhere in the output.
 */
export function scheduleProblems(
  stops: readonly ExtractedStop[],
  schedule: readonly ScheduleEntry[],
  ctx: ItineraryContext,
  opts: { english?: boolean; passenger: string; checkCc: boolean; missingTimesOk?: boolean },
): string[] {
  const problems: string[] = [];
  const used = new Set<number>();
  for (const e of schedule) {
    const name = opts.english ? (ENGLISH[e.place] ?? e.place) : e.place;
    const day = dayOfDate(ctx.startDate!, e.date);
    const i = stops.findIndex((s, k) => !used.has(k) && s.stop.day === day && !!s.stop.place && placeMatches(s.stop.place, name));
    if (i < 0) {
      problems.push(`missing ${name} on day ${day}`);
      continue;
    }
    used.add(i);
    const s = stops[i].stop;
    const arr = e.arrive && /^\d\d:\d\d$/.test(e.arrive) ? e.arrive : undefined;
    const ok = (got: string | undefined, want: string | undefined) => got === want || (opts.missingTimesOk === true && got === undefined);
    if (!ok(s.arr, arr)) problems.push(`${name} day ${day}: arr ${s.arr} != ${arr}`);
    if (!ok(s.dep, e.depart)) problems.push(`${name} day ${day}: dep ${s.dep} != ${e.depart}`);
    if (e.arrive === "morning" && !/morg|morning/i.test(s.note ?? "")) problems.push(`${name} day ${day}: note "${s.note}" lacks morning`);
    if (opts.checkCc && s.cc !== DANUBE_CC[e.place]) problems.push(`${name}: cc ${s.cc} != ${DANUBE_CC[e.place]}`);
  }
  stops.forEach((s, k) => {
    if (!used.has(k)) problems.push(`invented ${s.stop.sea ? "sea day" : s.stop.place} on day ${s.stop.day}`);
  });
  const text = JSON.stringify(stops);
  if (/paris/i.test(text)) problems.push("Paris in the output");
  if (text.includes(opts.passenger.split(" ")[1])) problems.push("passenger name in the output");
  return problems;
}
