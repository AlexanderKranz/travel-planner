/**
 * Live recording of the Haiku itinerary extraction (docs/specs/itinerary-upload.md section 9). Real calls, guarded by
 * the cost ledger. Run: `npm run evals:itinerary` (after `npm run evals:itinerary-docs` when the documents changed).
 * Writes evals/recorded/itinerary-extract.json (raw wire output per case); evals/itinerary-extract.test.ts replays it
 * through normalizeExtract and mapStops in `npm test`.
 *
 * Every text case sends exactly what the product sends: the prefiltered text. The packing list is the exception: in
 * the product the prefilter leaves nothing and no call is made; here its raw text checks the "not an itinerary" rule.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { MODEL_TAGS, type AiUsageRecord } from "@/lib/domain/ai";
import type { ItineraryContext } from "@/lib/domain/itinerary";
import { mapStops } from "@/lib/itinerary/map";
import { normalizeExtract, type WireItinerary } from "@/lib/itinerary/normalize";
import { prefilterItinerary } from "@/lib/itinerary/prefilter";
import { ITINERARY_PROMPT_VERSION } from "@/lib/plan/itinerary-prompt";
import { callStructured } from "@/lib/server/ai/client";
import { itineraryHash, itineraryRequest, type ItineraryPayload } from "@/lib/server/ai/itinerary-extract";
import { DANUBE, docLines, NOTES_MISSES, PASSENGER, PHOTO_DOC, pdfText, type ItineraryDocId } from "./itinerary-docs";
import { ITINERARY_FIXTURE_DIR, ITINERARY_RECORDING, scheduleProblems, withinBudget, type ItineraryCase, type RecordedCase } from "./itinerary-recorded";
import { assertBudget, recordSpend } from "./ledger";

vi.mock("server-only", () => ({}));

const LIVE = process.env.EVAL_LIVE === "1";
if (LIVE && !process.env.ANTHROPIC_API_KEY && existsSync(".env.local")) process.loadEnvFile(".env.local");

const ctx: ItineraryContext = { startDate: "2037-12-19", lengthDays: 5 };
const TODAY = "2026-11-11";

type LiveCase = ItineraryCase & { payload: () => Promise<{ payload: ItineraryPayload; text?: string; image?: string }> };

const docCase = (id: ItineraryDocId, expectWhat: ItineraryCase["expect"]): LiveCase => ({
  id,
  source: "upload",
  kind: "text",
  expect: expectWhat,
  payload: async () => {
    const pdf = join(ITINERARY_FIXTURE_DIR, `${id}.pdf`);
    const text = prefilterItinerary((await pdfText(new Uint8Array(readFileSync(pdf)))).text);
    return { payload: { kind: "text", text }, text };
  },
});

const CASES: LiveCase[] = [
  docCase("donau-table", "schedule"),
  docCase("donau-prose", "schedule"),
  docCase("injection", "schedule"),
  {
    id: PHOTO_DOC,
    source: "upload",
    kind: "images",
    expect: "schedule",
    payload: async () => {
      const data = readFileSync(join(ITINERARY_FIXTURE_DIR, `${PHOTO_DOC}.jpg`)).toString("base64");
      return { payload: { kind: "images", images: [{ mediaType: "image/jpeg", data }] }, image: `${PHOTO_DOC}.jpg` };
    },
  },
  {
    id: "not-an-itinerary-raw",
    source: "upload",
    kind: "text",
    expect: "empty",
    payload: async () => {
      const text = docLines("not-an-itinerary").map((l) => l.text).join("\n");
      return { payload: { kind: "text", text }, text };
    },
  },
  ...NOTES_MISSES.map(
    (n): LiveCase => ({
      id: n.id,
      source: "notes",
      kind: "text",
      expect: "schedule",
      english: n.english,
      payload: async () => {
        const text = prefilterItinerary(n.text);
        return { payload: { kind: "text", text }, text };
      },
    }),
  ),
];

describe.runIf(LIVE)("live itinerary extraction", () => {
  it("records the cases", async () => {
    expect(process.env.ANTHROPIC_API_KEY, "ANTHROPIC_API_KEY missing").toBeTruthy();
    const recorded: RecordedCase[] = [];
    const failures: string[] = [];
    for (const c of CASES) {
      assertBudget("itinerary_extract"); // throws before any call
      const { payload, text, image } = await c.payload();
      let usage: AiUsageRecord | undefined;
      const r = await callStructured(itineraryRequest(payload), {
        onUsage: async (u) => {
          usage = u;
          recordSpend({ fixture: `itinerary:${c.id}`, task: "itinerary_extract", costMicroUsd: u.costMicroUsd, status: u.status });
        },
      });
      const cost = `$${((usage?.costMicroUsd ?? 0) / 1e6).toFixed(5)}, in ${usage?.inputTokens} out ${usage?.outputTokens}`;
      if (!r.ok) {
        failures.push(`${c.id}: ${r.error}`);
        console.log(`ERR ${c.id} ${r.error} (${cost})`);
        continue;
      }
      const wire = r.data as WireItinerary;
      const { payload: _p, ...meta } = c as LiveCase & { payload: unknown };
      void _p;
      const rec: RecordedCase = { ...meta, ...(text !== undefined ? { text } : {}), ...(image ? { image } : {}), hash: itineraryHash(payload), wire, usage: r.usage };
      recorded.push(rec);

      const stops = mapStops(normalizeExtract(wire, payload.kind === "text" ? payload.text : null).stops, ctx, TODAY);
      const problems =
        c.expect === "empty"
          ? stops.length === 0
            ? []
            : [`expected no stops, got ${stops.length}`]
          : scheduleProblems(stops, DANUBE, ctx, { passenger: PASSENGER, english: c.english, checkCc: true });
      if (/paris/i.test(JSON.stringify(wire))) problems.push("Paris in the raw model output");
      problems.push(...withinBudget(rec));
      console.log(`${problems.length ? "FAIL" : "ok  "} ${c.id} (${cost})${problems.length ? "\n    " + problems.join("\n    ") : ""}`);
      if (problems.length) failures.push(`${c.id}: ${problems.join("; ")}`);
    }
    writeFileSync(
      ITINERARY_RECORDING,
      JSON.stringify({ promptVersion: ITINERARY_PROMPT_VERSION, model: MODEL_TAGS, recordedAt: new Date().toISOString(), cases: recorded }, null, 2) + "\n",
    );
    expect(failures).toEqual([]);
  });
});
