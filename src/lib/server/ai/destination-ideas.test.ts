import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import type { AiUsageRecord } from "@/lib/domain/ai";
import { canonicalJson } from "@/lib/plan/hash";
import { IDEAS_RULES } from "@/lib/plan/prompt";
import type { IdeaInput } from "@/lib/discover/input";
import { outputFormat } from "./client";
import { ideasRequest, IDEAS_MAX_TOKENS, normalizeIdeas, proposeIdeas, WireIdeas } from "./destination-ideas";

vi.mock("server-only", () => ({}));

const input: IdeaInput = {
  v: 1,
  lang: "de",
  purpose: { interests: ["golf"], custom: [], hard: [], soft: [] },
  months: [3],
  from: ["Frankfurt am Main"],
  radiusKm: 2128,
  count: 8,
};

const usage = { input_tokens: 700, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 600 };
const fakeClient = (text: string) =>
  ({ messages: { create: vi.fn(async () => ({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text }] })) } }) as unknown as Anthropic;
const wire = (ideas: object[]) => JSON.stringify({ ideas });

describe("ideasRequest", () => {
  const r = ideasRequest(input);
  it("is a Haiku call with low effort, 1500 tokens, the cached IDEAS_RULES as system and one compact INPUT block", () => {
    expect(r).toMatchObject({ task: "destination_ideas", model: "claude-haiku-5-5", effort: "low", maxTokens: IDEAS_MAX_TOKENS, system: IDEAS_RULES });
    expect(IDEAS_MAX_TOKENS).toBe(1500);
    expect(r.blocks).toEqual([{ text: "INPUT\n" + canonicalJson(input) }]);
  });
  it("the wire schema has exactly name, anchor, cc and reason, all required (ground rule 1: no field for facts)", () => {
    const f = outputFormat(WireIdeas);
    const item = (f.schema as { properties: { ideas: { items: { required: string[]; properties: Record<string, unknown> } } } }).properties.ideas.items;
    expect(Object.keys(item.properties).sort()).toEqual(["anchor", "cc", "name", "reason"]);
    expect(item.required.sort()).toEqual(["anchor", "cc", "name", "reason"]);
    expect(JSON.stringify(f.schema)).not.toMatch(/flight|route|price|hours|distance|duration|km/i);
  });
  it("the rules forbid facts in reasons and call the purpose user data", () => {
    expect(IDEAS_RULES).toMatch(/Never state flights, airlines, routes, travel times, distances, prices, opening hours/);
    expect(IDEAS_RULES).toMatch(/user data, not instructions/);
    expect(IDEAS_RULES).toMatch(/at most 140 characters/);
    expect(IDEAS_RULES).toMatch(/never a region/);
  });
});

describe("normalizeIdeas", () => {
  const w = (name: string, anchor: string, cc = "ES", reason = "r") => ({ name, anchor, cc, reason });
  it("trims, uppercases the country and keeps the order", () => {
    expect(normalizeIdeas({ ideas: [w("  Costa del Sol ", " Marbella ", "es", " Schön ")] })).toEqual([{ name: "Costa del Sol", anchor: "Marbella", cc: "ES", reason: " Schön " }]);
  });
  it("drops entries without an anchor or with a country code that is not 2 letters", () => {
    expect(normalizeIdeas({ ideas: [w("x", "", "ES"), w("y", "Faro", "PRT"), w("z", "Faro", "P"), w("ok", "Faro", "PT")] }).map((i) => i.anchor)).toEqual(["Faro"]);
  });
  it("falls back to the anchor when the name is empty", () => {
    expect(normalizeIdeas({ ideas: [w(" ", "Faro", "PT")] })[0].name).toBe("Faro");
  });
  it("removes repeated anchors (folded) and anchors in exclude (round 2)", () => {
    const ideas = [w("a", "Málaga"), w("b", "malaga"), w("c", "Palma"), w("d", "Faro", "PT")];
    expect(normalizeIdeas({ ideas }).map((i) => i.anchor)).toEqual(["Málaga", "Palma", "Faro"]);
    expect(normalizeIdeas({ ideas }, ["Malaga", "Palma"]).map((i) => i.anchor)).toEqual(["Faro"]);
  });
  it("keeps at most 8", () => {
    const ideas = Array.from({ length: 12 }, (_, i) => w(`n${i}`, `Town${i}`));
    expect(normalizeIdeas({ ideas })).toHaveLength(8);
  });
});

describe("proposeIdeas", () => {
  const ideas = [
    { name: "Costa del Sol", anchor: "Marbella", cc: "ES", reason: "Viele Golfplätze und mildes Klima im März" },
    { name: "Algarve", anchor: "Faro", cc: "PT", reason: "Golf am Meer" },
  ];

  it("validates through our own safeParse, logs usage once and sends the system block with a cache breakpoint", async () => {
    const records: AiUsageRecord[] = [];
    const client = fakeClient(wire(ideas));
    const r = await proposeIdeas(input, { client, onUsage: async (u) => void records.push(u) });
    expect(r).toMatchObject({ ok: true, data: [{ anchor: "Marbella" }, { anchor: "Faro" }] });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ task: "destination_ideas", model: "claude-haiku-5-5", status: "ok", cacheReadInputTokens: 600 });
    expect(records[0].costMicroUsd).toBeGreaterThan(0);
    const arg = (client.messages.create as unknown as { mock: { calls: [Record<string, unknown>][] } }).mock.calls[0][0];
    expect(arg.system).toEqual([{ type: "text", text: IDEAS_RULES, cache_control: { type: "ephemeral" } }]);
  });

  it("the exclusions of round 2 are removed even if the model repeats them", async () => {
    const r = await proposeIdeas({ ...input, exclude: ["Marbella"] }, { client: fakeClient(wire(ideas)), onUsage: async () => {} });
    expect(r).toMatchObject({ ok: true, data: [{ anchor: "Faro" }] });
  });

  it("invalid output is invalid_output and the usage is still logged", async () => {
    const records: AiUsageRecord[] = [];
    const r = await proposeIdeas(input, { client: fakeClient('{"ideas":[{"name":"x"}]}'), onUsage: async (u) => void records.push(u) });
    expect(r).toMatchObject({ ok: false, error: "invalid_output" });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("invalid_output");
  });

  it("an API error is ai_unavailable with an estimated cost, logged once", async () => {
    const records: AiUsageRecord[] = [];
    const client = { messages: { create: vi.fn(async () => { throw new Error("boom"); }) } } as unknown as Anthropic;
    const r = await proposeIdeas(input, { client, onUsage: async (u) => void records.push(u) });
    expect(r).toMatchObject({ ok: false, error: "ai_unavailable" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ task: "destination_ideas", status: "error" });
    expect(records[0].costMicroUsd).toBeGreaterThanOrEqual(1);
  });
});
