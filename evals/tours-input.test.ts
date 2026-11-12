/**
 * City tours in the plan input (docs/specs/city-tour.md sections 10 and 13, "Plan"): the reference trips stay
 * byte-identical without tours, and a linked tour with a start time enters `fixed` as an activity slot.
 */
import { describe, expect, it, vi } from "vitest";
import type { PurposeTags } from "@/lib/domain/plan";
import { canonicalJson, planInputHash } from "@/lib/plan/hash";
import { linkedTour, wienInput } from "@/lib/plan/tour-test-helpers";
import { buildEvalInput, FIXTURE_IDS } from "./build-input";
import { readRecording } from "./recorded";

vi.mock("server-only", () => ({}));

const tagsOf = (id: (typeof FIXTURE_IDS)[number]) => readRecording<PurposeTags>(id, "tags")?.output ?? null;

describe.each(FIXTURE_IDS)("eval %s without tours", (id) => {
  it("is byte-identical whether tours are absent, empty, or only off the trip's days", () => {
    const tags = tagsOf(id);
    const base = buildEvalInput(id, tags);
    const empty = buildEvalInput(id, tags, undefined, undefined, []);
    const offDays = buildEvalInput(id, tags, undefined, undefined, [linkedTour({ tripDay: null }), linkedTour({ id: "x", tripDay: 59 })]);
    for (const other of [empty, offDays]) {
      expect(canonicalJson(other.stored)).toBe(canonicalJson(base.stored));
      expect(planInputHash(other.stored.llm)).toBe(planInputHash(base.stored.llm));
    }
    expect("tourStops" in base.stored).toBe(false);
  });

  it("a tour without a start time leaves the model input unchanged (it only feeds the duplicate guard)", () => {
    const tags = tagsOf(id);
    const base = buildEvalInput(id, tags);
    const untimed = buildEvalInput(id, tags, undefined, undefined, [linkedTour({ tripDay: 1, input: wienInput() })]);
    expect(canonicalJson(untimed.stored.llm)).toBe(canonicalJson(base.stored.llm));
    expect(untimed.stored.tourStops).toEqual({ "1": ["way/1", "way/2", "way/3"] });
  });
});

describe("eval golf with a linked tour", () => {
  it("enters fixed as an activity slot in day/start order and changes the input hash", () => {
    const tags = tagsOf("golf");
    const base = buildEvalInput("golf", tags);
    const tour = buildEvalInput("golf", tags, undefined, undefined, [linkedTour({ tripDay: 3, input: wienInput({ startTime: "10:00" }) })]);
    expect(tour.stored.llm.fixed).toEqual([
      { day: 1, from: "13:00", to: "16:00", cat: "flight" },
      { day: 3, from: "10:00", to: "12:10", cat: "activity", title: "Stadttour: Hofburg, Stephansdom, Naschmarkt" },
      { day: 3, from: "20:00", to: "22:00", cat: "food", title: "Tisch im Restaurant am Hafen" },
    ]);
    expect(planInputHash(tour.stored.llm)).not.toBe(planInputHash(base.stored.llm));
    // Only `fixed` differs: no prompt change, nothing else of the input moves.
    const { fixed: _a, ...restTour } = tour.stored.llm;
    const { fixed: _b, ...restBase } = base.stored.llm;
    void _a;
    void _b;
    expect(canonicalJson(restTour)).toBe(canonicalJson(restBase));
  });
});
