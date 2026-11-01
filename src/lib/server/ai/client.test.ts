import { describe, expect, it, vi } from "vitest";
import { LlmPatch, LlmPlan, PurposeTags } from "@/lib/domain/plan";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { AiUsageRecord } from "@/lib/domain/ai";
import { CLIENT_MAX_RETRIES, CLIENT_TIMEOUT_MS, callStructured, estimateFailedCostMicroUsd, outputFormat } from "./client";

vi.mock("server-only", () => ({}));

// Verifies the SDK's zodOutputFormat accepts our Zod 4 schemas (spec 4.2). No API call.
describe("outputFormat", () => {
  it.each([
    ["LlmPlan", LlmPlan],
    ["LlmPatch", LlmPatch],
    ["PurposeTags", PurposeTags],
  ])("builds a json_schema format for %s", (_, schema) => {
    const f = outputFormat(schema);
    expect(f.type).toBe("json_schema");
    expect(f.schema).toMatchObject({ type: "object", additionalProperties: false });
    expect(Array.isArray(f.schema.required)).toBe(true);
  });

  // SDK 1.3 demotes enum/const to description hints (not grammar-enforced). Zod still rejects
  // bad values on parse, so an invalid enum surfaces as a thrown parse error (-> invalid_output).
  it("rejects an enum value outside the schema on parse", () => {
    const f = outputFormat(PurposeTags);
    const bad = { v: 1, interests: ["golfing"], custom: [], hard: [], soft: [], summary: "" };
    expect(() => f.parse(JSON.stringify(bad))).toThrow();
  });

  it("parses valid model text with the same schema", () => {
    const f = outputFormat(LlmPlan);
    const text = JSON.stringify({ summary: "s", days: [], notes: [], open: [], packing: [] });
    expect(f.parse(text)).toEqual({ summary: "s", days: [], notes: [], open: [], packing: [] });
    expect(() => f.parse(JSON.stringify({ summary: 1 }))).toThrow();
  });
});

// --- callStructured with a mocked SDK client (spec 9) ---

const usage = { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 10, cache_read_input_tokens: 20 };
const msg = (text: string | null, stop = "end_turn") => ({
  id: "m",
  type: "message",
  role: "assistant",
  model: "claude-haiku-5-5",
  stop_reason: stop,
  usage,
  content: [{ type: "thinking", thinking: "", signature: "" }, ...(text === null ? [] : [{ type: "text", text }])],
});

function setup(result: unknown, extra: { noThinking?: boolean } = {}) {
  const create = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });
  const records: AiUsageRecord[] = [];
  const ctx = { client: { messages: { create } } as unknown as Anthropic, onUsage: async (u: AiUsageRecord) => void records.push(u) };
  const S = z.object({ a: z.number() });
  const req = { task: "purpose_tags" as const, model: "claude-haiku-5-5" as const, schema: S, effort: "low" as const, maxTokens: 100, system: "SYS", blocks: [{ text: "INPUT", cache: true }, { text: "FB" }], ...extra };
  return { create, records, run: () => callStructured(req, ctx) };
}

describe("callStructured", () => {
  it("sends thinking disabled when the request asks for it", async () => {
    const t = setup(msg('{"a":1}'), { noThinking: true });
    await t.run();
    const params = (t.create.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(params.thinking).toEqual({ type: "disabled" });
  });

  it("returns parsed data, one usage record with cost, and sends cached blocks", async () => {
    const t = setup(msg('{"a":1}'));
    const r = await t.run();
    expect(r).toMatchObject({ ok: true, data: { a: 1 } });
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ status: "ok", inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 10, cacheReadInputTokens: 20, costMicroUsd: 36 });
    const params = (t.create.mock.calls[0] as unknown[])[0] as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    expect(params.system).toEqual([{ type: "text", text: "SYS", cache_control: { type: "ephemeral" } }]);
    expect(params.messages[0].content).toEqual([
      { type: "text", text: "INPUT", cache_control: { type: "ephemeral" } },
      { type: "text", text: "FB" },
    ]);
    expect(params.output_config).toMatchObject({ effort: "low", format: { type: "json_schema" } });
    expect(params).not.toHaveProperty("thinking");
  });

  it.each([
    ["refusal", msg('{"a":1}', "refusal"), "ai_refused", "refusal"],
    ["max_tokens", msg('{"a":', "max_tokens"), "invalid_output", "max_tokens"],
    ["no text", msg(null), "invalid_output", "invalid_output"],
    ["bad json", msg("{nope"), "invalid_output", "invalid_output"],
    ["zod failure", msg('{"a":"x"}'), "invalid_output", "invalid_output"],
  ])("%s → %s with billed usage", async (_, m, error, status) => {
    const t = setup(m);
    const r = await t.run();
    expect(r).toMatchObject({ ok: false, error });
    expect(t.records).toHaveLength(1);
    expect(t.records[0]).toMatchObject({ status, inputTokens: 100 });
  });

  it.each([
    [new Anthropic.RateLimitError(429, undefined, "rate", new Headers()), "http_429"],
    [new Anthropic.InternalServerError(529, undefined, "overloaded", new Headers()), "http_529"],
    [new Anthropic.APIConnectionTimeoutError(), "timeout"],
    [new Anthropic.APIConnectionError({ message: "x" }), "network"],
    [new Error("boom"), "unknown"],
  ])("API error %# → ai_unavailable (%s) with an estimated cost", async (err, code) => {
    const t = setup(err);
    const r = await t.run();
    expect(r).toMatchObject({ ok: false, error: "ai_unavailable" });
    expect(t.records).toEqual([expect.objectContaining({ status: "error", errorCode: code, inputTokens: 0, outputTokens: 0 })]);
    expect(t.records[0].costMicroUsd).toBeGreaterThan(0);
  });

  it("estimates a failed call as prompt chars / 4 at the input price, no output", () => {
    // 4000 chars → 1000 input tokens × 2 µUSD (plan model) = 2000; Haiku: 1000 × 0.1 = 100.
    const blocks = [{ text: "x".repeat(3000) }];
    expect(estimateFailedCostMicroUsd({ model: "claude-sonnet-5-5", system: "y".repeat(1000), blocks })).toBe(2000);
    expect(estimateFailedCostMicroUsd({ model: "claude-haiku-5-5", system: "y".repeat(1000), blocks })).toBe(100);
  });

  it("makes one attempt within the route budget", () => {
    expect(CLIENT_MAX_RETRIES).toBe(0);
    expect(CLIENT_TIMEOUT_MS).toBeLessThanOrEqual(150_000);
  });

  it("survives a throwing onUsage", async () => {
    const t = setup(msg('{"a":2}'));
    const create = t.create;
    const r = await callStructured(
      { task: "plan_patch", model: "claude-sonnet-5-5", schema: z.object({ a: z.number() }), effort: "low", maxTokens: 10, system: "S", blocks: [{ text: "I" }] },
      { client: { messages: { create } } as unknown as Anthropic, onUsage: async () => { throw new Error("db down"); } },
    );
    expect(r.ok).toBe(true);
  });
});
