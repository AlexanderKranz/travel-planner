import { describe, expect, it, vi } from "vitest";
import golf from "@/lib/plan/__fixtures__/plan-golf.json";
import { Plan, type PlanFeedback } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import { SYSTEM_RULES } from "@/lib/plan/prompt";
import type { PlanInputStored } from "@/lib/plan/input";
import { composeRequest, generateMaxTokens, normalizePatch, normalizePlan, patchBlocks, patchRequest, patchScope } from "./compose";
import { needsTags, normalizeTags, tagsRequest } from "./purpose-tags";

vi.mock("server-only", () => ({}));

const plan = Plan.parse(golf);
const keys = [...new Set(plan.days.flatMap((d) => d.stops.flatMap((s) => s.acts.flatMap((a) => (a.ref ? [a.ref] : [])))))];
const index: PlanInputStored["index"] = Object.fromEntries(keys.map((k, i) => [`p${i + 1}`, { key: k, place: plan.places[k] }]));
const llm = { v: 1 as const, lang: "de" as const, trip: { dest: "X", kind: "region" as const, days: 5, flights: true }, dayList: [1, 2, 3, 4, 5].map((n) => ({ n })), places: [], noSource: [] };
const fb = (f: Partial<PlanFeedback>): PlanFeedback => ({ chips: [], days: [], ...f });

describe("compose requests", () => {
  it("generation: Sonnet, medium effort, token cap by days, only the system block cached", () => {
    const r = composeRequest(llm);
    expect(r).toMatchObject({ task: "plan_generate", model: "claude-sonnet-5-5", effort: "medium", maxTokens: 12000 });
    expect(r.blocks).toEqual([{ text: expect.stringMatching(/^INPUT\n\{"dayList"/) }]);
    expect(generateMaxTokens(21)).toBe(31200);
    expect(generateMaxTokens(30)).toBe(32000);
    expect(SYSTEM_RULES.length).toBeGreaterThan(2000); // >= 512 tokens so it caches
  });

  it("patch: INPUT cached first, then CURRENT_PLAN and FEEDBACK", () => {
    const r = patchRequest({ llm, plan, index, feedback: fb({ chips: ["more_rest"], days: [2] }) });
    expect(r).toMatchObject({ task: "plan_patch", effort: "medium", maxTokens: 8000 });
    expect(r.blocks.map((b) => [b.text.split("\n")[0], !!b.cache])).toEqual([["INPUT", true], ["CURRENT_PLAN", false], ["FEEDBACK", false]]);
  });

  it("CURRENT_PLAN has scoped days in full with p ids and the rest as title + refs", () => {
    const [current, feedback] = patchBlocks(plan, index, fb({ chips: ["redo_day"], days: [4], text: "mehr Strand" }));
    const c = JSON.parse(current.slice("CURRENT_PLAN\n".length));
    expect(c.days[3].stops).toBeDefined();
    expect(c.days[0].stops).toBeUndefined();
    expect(c.days[0].refs.every((r: string) => /^p\d+$/.test(r))).toBe(true);
    expect(current).not.toMatch(/way\/|node\/|"date"/);
    const f = JSON.parse(feedback.slice("FEEDBACK\n".length));
    expect(f).toEqual({ days: [4], do: ["Rewrite the given days with different activities."], text: "mehr Strand" });
  });

  it("scope: given days (deduped, in range) or all days", () => {
    expect(patchScope(fb({ days: [3, 3, 1, 9] }), 5)).toEqual([1, 3]);
    expect(patchScope(fb({}), 3)).toEqual([1, 2, 3]);
  });

  it("normalizes unknown kinds instead of failing", () => {
    const day = { n: 1, title: "t", stops: [{ place: "p", acts: [{ kind: "relax", text: "x" }, { kind: "sport", text: "y" }] }] };
    const p = normalizePlan({ summary: "", days: [day], notes: [{ kind: "hint", text: "n" }], open: [], packing: [] });
    expect(p.days[0].stops[0].acts.map((a) => a.kind)).toEqual(["do", "sport"]);
    expect(p.notes[0].kind).toBe("tip");
    expect(normalizePatch({ reply: "r", days: [day] })).not.toHaveProperty("notes");
  });
});

const purpose = (over: Partial<TripPurpose> = {}): TripPurpose => ({ id: "p", name: "n", guided: {}, constraints: [], tags: null, createdAt: "", updatedAt: "", ...over });

describe("purpose tags", () => {
  it("needsTags only for text, constraints or custom interests", () => {
    expect(needsTags(purpose())).toBe(false);
    expect(needsTags(purpose({ guided: { interests: ["golf"], pace: "relaxed" } }))).toBe(false);
    expect(needsTags(purpose({ text: " Golf " }))).toBe(true);
    expect(needsTags(purpose({ constraints: ["flat"] }))).toBe(true);
    expect(needsTags(purpose({ guided: { interests: ["Pilze"] } }))).toBe(true);
  });

  it("request: Haiku, low effort, compact PURPOSE block", () => {
    const r = tagsRequest(purpose({ text: "Golf", constraints: ["flat"], guided: { interests: ["golf", "Pilze"] } }));
    expect(r).toMatchObject({ task: "purpose_tags", model: "claude-haiku-5-5", effort: "low", maxTokens: 1500 });
    expect(r.blocks[0].text).toBe('PURPOSE\n{"constraints":["flat"],"custom":["Pilze"],"text":"Golf"}');
  });

  it("normalize drops unknown keys, bad pace, duplicates and caps lengths", () => {
    const t = normalizeTags({ v: 2, interests: ["golf", "golfing", "golf"], custom: [" a ", "A"], pace: "fast", hard: ["x".repeat(300)], soft: [], summary: "s".repeat(400) });
    expect(t).toEqual({ v: 1, interests: ["golf"], custom: ["a"], hard: ["x".repeat(200)], soft: [], summary: "s".repeat(300) });
  });
});
