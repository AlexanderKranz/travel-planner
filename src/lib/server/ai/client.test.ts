import { describe, expect, it, vi } from "vitest";
import { LlmPatch, LlmPlan, PurposeTags } from "@/lib/domain/plan";
import { outputFormat } from "./client";

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
