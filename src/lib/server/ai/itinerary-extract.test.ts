import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { AiUsageRecord } from "@/lib/domain/ai";
import { ITINERARY_PROMPT_VERSION, ITINERARY_RULES } from "@/lib/plan/itinerary-prompt";
import { outputFormat } from "./client";
import { extractItineraryStops, itineraryHash, itineraryRequest, ITINERARY_MAX_TOKENS } from "./itinerary-extract";

vi.mock("server-only", () => ({}));

const TEXT = "Sa 19.12. Passau, Abfahrt 16 Uhr\nSo 20.12. Wien, Ankunft 14 Uhr";
const PNG = { mediaType: "image/png" as const, data: "iVBORw0KGgo=" };

describe("itineraryRequest", () => {
  it("is the Haiku task of section 3.4: low effort, no thinking, 1500 tokens, static system prompt", () => {
    const r = itineraryRequest({ kind: "text", text: TEXT });
    expect(r).toMatchObject({ task: "itinerary_extract", model: "claude-haiku-5-5", effort: "low", maxTokens: ITINERARY_MAX_TOKENS, noThinking: true, system: ITINERARY_RULES });
    expect(ITINERARY_MAX_TOKENS).toBe(1500);
    expect(r.blocks).toEqual([{ text: "TEXT\n" + JSON.stringify({ text: TEXT }) }]);
  });

  it("sends images first, then a short label, and no text of the document", () => {
    const r = itineraryRequest({ kind: "images", images: [PNG, PNG] });
    expect(r.blocks).toEqual([{ image: PNG }, { image: PNG }, { text: "IMAGES 2" }]);
  });

  it("has a wire schema with every field required (no optional properties)", () => {
    const f = outputFormat(itineraryRequest({ kind: "text", text: TEXT }).schema);
    const item = (f.schema.properties as Record<string, { items: { required: string[]; properties: object } }>).stops.items;
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
    expect(item.required.sort()).toEqual(["arr", "cc", "date", "day", "dep", "note", "place", "sea"]);
  });

  it("keeps the system prompt short (about 400 tokens) and versioned", () => {
    expect(ITINERARY_PROMPT_VERSION).toBe("itinerary-1");
    expect(ITINERARY_RULES.length / 4).toBeLessThan(600);
  });
});

describe("itineraryHash", () => {
  it("is stable for the same payload and differs for another text or image", () => {
    const a = itineraryHash({ kind: "text", text: TEXT });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(itineraryHash({ kind: "text", text: TEXT })).toBe(a);
    expect(itineraryHash({ kind: "text", text: TEXT + " " })).not.toBe(a);
    expect(itineraryHash({ kind: "images", images: [PNG] })).not.toBe(itineraryHash({ kind: "images", images: [{ ...PNG, data: "AAAA" }] }));
  });
});

describe("extractItineraryStops", () => {
  const reply = (stops: unknown[]) => ({
    id: "m",
    type: "message",
    role: "assistant",
    model: "claude-haiku-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 900, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    content: [{ type: "text", text: JSON.stringify({ stops }) }],
  });
  const stop = (x: object) => ({ date: null, day: null, place: null, cc: null, arr: null, dep: null, sea: false, note: null, ...x });

  it("text path: checks places against the text, logs usage once", async () => {
    const create = vi.fn(async () => reply([stop({ date: "--12-19", place: "Passau", cc: "DE", dep: "16:00" }), stop({ place: "Paris", cc: "FR" })]));
    const usage: AiUsageRecord[] = [];
    const r = await extractItineraryStops({ kind: "text", text: TEXT }, { client: { messages: { create } } as unknown as Anthropic, onUsage: async (u) => void usage.push(u) });
    expect(r.ok && r.data).toEqual({ stops: [{ date: "--12-19", place: "Passau", cc: "DE", dep: "16:00" }], drops: { notInSource: 1, noPlace: 0, invalid: 0 } });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ task: "itinerary_extract", status: "ok", inputTokens: 900, outputTokens: 300, costMicroUsd: 240 });
  });

  it("image path: flags every stop from_image", async () => {
    const create = vi.fn(async () => reply([stop({ place: "Wien", arr: "14:00" })]));
    const r = await extractItineraryStops({ kind: "images", images: [PNG] }, { client: { messages: { create } } as unknown as Anthropic, onUsage: async () => {} });
    expect(r.ok && r.data.stops).toEqual([{ place: "Wien", arr: "14:00", flags: ["from_image"] }]);
  });
});
