import { describe, expect, it, vi } from "vitest";
import golf from "@/lib/plan/__fixtures__/plan-golf.json";
import { Plan, PurposeTags, type PlanFeedback } from "@/lib/domain/plan";
import type { TripPurpose } from "@/lib/domain/purpose";
import { SYSTEM_RULES } from "@/lib/plan/prompt";
import type { PlanInputStored } from "@/lib/plan/input";
import { composeRequest, generateMaxTokens, normalizePatch, normalizePlan, patchBlocks, patchPlan, patchRequest, patchScope } from "./compose";
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

  it("CURRENT_PLAN maps alts back to p ids (unknown keys dropped)", () => {
    const p = structuredClone(plan) as Plan;
    const act = p.days[3].stops.flatMap((s) => s.acts).find((a) => a.ref)!;
    const other = keys.find((k) => k !== act.ref)!;
    act.alts = [other, "way/999999"];
    const [current] = patchBlocks(p, index, fb({ days: [4] }));
    const day = JSON.parse(current.slice("CURRENT_PLAN\n".length)).days[3];
    const mapped = day.stops.flatMap((s: { acts: { ref?: string; alts?: string[] }[] }) => s.acts).find((a: { alts?: string[] }) => a.alts);
    expect(mapped.alts).toEqual([Object.keys(index).find((id) => index[id].key === other)]);
    expect(current).not.toMatch(/way\/|node\//);
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

const purpose = (over: Partial<TripPurpose> = {}): TripPurpose => ({ id: "p", name: "n", guided: {}, constraints: [], tags: null, ownerId: "u", access: "owner", usable: true, createdAt: "", updatedAt: "", ...over });

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
    expect(r).toMatchObject({ task: "purpose_tags", model: "claude-haiku-5-5", effort: "low", maxTokens: 3000 });
    expect(r.blocks[0].text).toBe('PURPOSE\n{"constraints":["flat"],"custom":["Pilze"],"text":"Golf"}');
  });

  it("normalize drops unknown keys, bad pace, duplicates and caps lengths", () => {
    const t = normalizeTags({ v: 2, interests: ["golf", "golfing", "golf"], custom: [" a ", "A"], pace: "fast", hard: ["x".repeat(300)], soft: [], summary: "s".repeat(400) });
    expect(t).toEqual({ v: 2, interests: ["golf"], custom: ["a"], hard: ["x".repeat(200)], soft: [], summary: "s".repeat(300) });
  });

  const base = { v: 2, interests: [], custom: ["escape room"], hard: [], soft: [], summary: "" };
  it("v2: activity wishes keep catalogue types, drop unknown ones and entries with nothing to load", () => {
    const t = normalizeTags({
      ...base,
      activities: [
        { types: ["escape_game", "laser_maze", "escape_game"], open: true, group: "outdoor", label: "  Friday   evening event " },
        { types: ["rowing", "footgolf"], open: false },
        { types: [], open: false, group: "indoor" },
        { types: ["unknown"], open: true },
        { types: [], open: true, group: "spa" },
        { types: ["bar"], open: false },
        { types: ["cinema"], open: false },
      ],
    });
    expect(t.activities).toEqual([
      { types: ["escape_game"], open: true, label: "Friday evening event" },
      { types: ["rowing", "footgolf"], open: false },
      { types: [], open: true, group: "indoor" },
      { types: ["bar"], open: false },
    ]);
  });

  it("v2: cuisine keeps known values only and is omitted when empty", () => {
    expect(normalizeTags({ ...base, cuisine: { local: true, include: ["German", "schnitzel"], exclude: ["pizza", "german"] } }).cuisine).toEqual({
      local: true,
      include: ["german"],
      exclude: ["pizza"],
    });
    expect(normalizeTags({ ...base, cuisine: { local: false, include: ["xyz"], exclude: [] } }).cuisine).toBeUndefined();
  });

  it("stored v1 tags (tags-1, no activities or cuisine) still parse", () => {
    expect(PurposeTags.safeParse({ v: 1, interests: ["golf"], custom: [], hard: [], soft: [], summary: "" }).success).toBe(true);
  });

  it("the tags prompt lists the activity types and cuisines", () => {
    const r = tagsRequest(purpose({ text: "x" }));
    expect(r.system).toContain("escape_game");
    expect(r.system).toContain("franconian");
  });
});

describe("needPlaces (activities spec section 4)", () => {
  const wire = { reply: "r", days: [] };
  it("keeps catalogue types, known cuisines and near; drops an empty request", () => {
    const p = normalizePatch({ ...wire, needPlaces: { types: ["escape_game", "x"], restaurants: { cuisine: { local: true, include: ["sushi", "q"] }, near: " a2 " } } });
    expect(p.needPlaces).toEqual({ types: ["escape_game"], restaurants: { cuisine: { local: true, include: ["sushi"], exclude: [] }, near: "a2" } });
    expect(normalizePatch({ ...wire, needPlaces: { types: ["x"] } }).needPlaces).toBeUndefined();
    expect(normalizePatch(wire).needPlaces).toBeUndefined();
  });

  it("flags a request with nothing loadable as unusable; keeps `local` unset when the model did not set it", () => {
    expect(normalizePatch({ ...wire, needPlaces: { types: ["laser_maze"] } }).needPlacesUnusable).toBe(true);
    expect(normalizePatch(wire).needPlacesUnusable).toBeUndefined();
    const p = normalizePatch({ ...wire, needPlaces: { restaurants: { cuisine: { exclude: ["pizza"] } } } });
    expect(p.needPlaces).toEqual({ restaurants: { cuisine: { include: [], exclude: ["pizza"] } } });
  });

  it("patchPlan with loaded drops a repeated needPlaces and flags it", async () => {
    const answer = { reply: "noch mehr laden", days: [], needPlaces: { types: ["bowling"] } };
    const client = {
      messages: {
        create: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text: JSON.stringify(answer) }],
          usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
        }),
      },
    };
    const ctx = { onUsage: async () => {}, client: client as never };
    const second = await patchPlan({ llm, plan, index, feedback: fb({ text: "x" }), loaded: true }, ctx);
    expect(second.ok && second.data.needPlaces).toBeFalsy();
    expect(second.ok && second.data.needPlacesUnusable).toBe(true);
    const first = await patchPlan({ llm, plan, index, feedback: fb({ text: "x" }) }, ctx);
    expect(first.ok && first.data.needPlaces).toEqual({ types: ["bowling"] });
  });

  it("the second call marks FEEDBACK as loaded and passes the deadline as timeout", () => {
    const r = patchRequest({ llm, plan, index, feedback: fb({ text: "Escape Rooms" }), loaded: true, timeoutMs: 90_000 });
    expect(r.blocks[2].text).toContain('"loaded":true');
    expect(r.timeoutMs).toBe(90_000);
    expect(patchRequest({ llm, plan, index, feedback: fb({ text: "x" }) }).blocks[2].text).not.toContain("loaded");
  });

  it("the patch addendum explains needPlaces and forbids it after loading", () => {
    const r = patchRequest({ llm, plan, index, feedback: fb({ text: "x" }) });
    expect(r.system).toContain("needPlaces");
    expect(r.system).toContain("FEEDBACK.loaded");
  });
});

describe("patch with fixed items", () => {
  const slot = { day: 1, from: "07:50", to: "10:40", cat: "flight" as const };
  it("sends no fixed key when the items match INPUT.fixed (INPUT block stays the cached prefix)", () => {
    const r = patchRequest({ llm: { ...llm, fixed: [slot] }, plan, index, feedback: fb({ chips: ["more_rest"] }), fixed: [slot] });
    expect(r.blocks[0]).toMatchObject({ cache: true });
    expect(r.blocks[1].text).not.toContain('"fixed"');
  });
  it("sends the current fixed slots in CURRENT_PLAN when items changed, [] when all were removed", () => {
    const changed = patchRequest({ llm, plan, index, feedback: fb({ chips: ["more_rest"] }), fixed: [slot] });
    expect(changed.blocks[0].text).not.toContain('"fixed"');
    expect(changed.blocks[1].text).toContain('"fixed":[{"cat":"flight","day":1,"from":"07:50","to":"10:40"}]');
    const removed = patchRequest({ llm: { ...llm, fixed: [slot] }, plan, index, feedback: fb({ chips: ["more_rest"] }), fixed: undefined });
    expect(removed.blocks[1].text).toContain('"fixed":[]');
  });
  it("the system prompt states the fixed-item rule (plan-4)", () => {
    expect(SYSTEM_RULES).toMatch(/fixed items are shown by the app/);
    expect(SYSTEM_RULES).toMatch(/at least 90 min after its to/);
    expect(SYSTEM_RULES).toMatch(/at least 150 min before its from/);
  });
});
