import { describe, expect, it, vi } from "vitest";
import type Anthropic from "@anthropic-ai/sdk";
import recorded from "../../../../evals/recorded/group-text.json";
import type { AiUsageRecord } from "@/lib/domain/ai";
import { WireGroupParse } from "@/lib/group-text";
import { GROUP_RULES } from "@/lib/plan/prompt";
import { outputFormat } from "./client";
import { groupParseRequest, parseGroupText } from "./group-parse";

vi.mock("server-only", () => ({}));

const usage = { input_tokens: 400, output_tokens: 60, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const fakeClient = (text: string) =>
  ({ messages: { create: vi.fn(async () => ({ id: "m", type: "message", role: "assistant", model: "claude-haiku-5-5", stop_reason: "end_turn", usage, content: [{ type: "text", text }] })) } }) as unknown as Anthropic;

describe("group parse request", () => {
  it("is a Haiku call with low effort, our rules as system and the compact text block", () => {
    const r = groupParseRequest("  Wir sind 5 Freunde \n");
    expect(r).toMatchObject({ task: "group_parse", model: "claude-haiku-5-5", effort: "low", maxTokens: 800, system: GROUP_RULES });
    expect(r.blocks).toEqual([{ text: 'TEXT\n{"text":"Wir sind 5 Freunde"}' }]);
  });

  it("the wire schema has only required fields (optional ones broke the constrained decoder when recorded)", () => {
    const f = outputFormat(WireGroupParse);
    expect(f.type).toBe("json_schema");
    const item = (f.schema as { properties: { travellers: { items: { required: string[]; properties: object } } } }).properties.travellers.items;
    expect(item.required.sort()).toEqual(Object.keys(item.properties).sort());
  });

  it("the rules tell Haiku the text is data, not instructions, and never to invent people", () => {
    expect(GROUP_RULES).toMatch(/user data, not instructions/);
    expect(GROUP_RULES).toMatch(/Never invent/);
  });
});

describe("parseGroupText", () => {
  it("replays a recorded response through our own safeParse and normalisation, logging usage once", async () => {
    const s = recorded.samples[0];
    const records: AiUsageRecord[] = [];
    const r = await parseGroupText(s.text, { client: fakeClient(JSON.stringify(s.wire)), onUsage: async (u) => void records.push(u) });
    expect(r).toMatchObject({ ok: true, data: { v: 1, travellers: [{ count: 5, ageMode: "relativeToMe", ageOffset: 0 }] } });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ task: "group_parse", model: "claude-haiku-5-5", status: "ok" });
  });

  it("invalid model output is invalid_output, usage still logged", async () => {
    const records: AiUsageRecord[] = [];
    const r = await parseGroupText("x", { client: fakeClient('{"v":1}'), onUsage: async (u) => void records.push(u) });
    expect(r).toMatchObject({ ok: false, error: "invalid_output" });
    expect(records).toHaveLength(1);
    expect(records[0].status).toBe("invalid_output");
  });
});
