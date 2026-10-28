import { describe, expect, it } from "vitest";
import { Plan } from "@/lib/domain/plan";
import { assemblePlan } from "./assemble";
import { header, llmDay, llmPlan, storedFor } from "./test-helpers";

const run = (llm = llmPlan(3), stored = storedFor(3)) =>
  assemblePlan({ llm, stored, header: header(3), digest: {}, locale: "de" });

describe("assemblePlan", () => {
  it("builds a valid plan with code dates, OSM refs and only referenced places", () => {
    const r = run();
    if (!r.ok) throw new Error(r.reason);
    expect(Plan.safeParse(r.plan).success).toBe(true);
    expect(r.plan.days.map((d) => d.date)).toEqual(["2038-03-13", "2038-03-14", "2038-03-15"]);
    expect(r.plan.days[0].stops[0].acts[0].ref).toBe("way/1");
    expect(Object.keys(r.plan.places).sort()).toEqual(["way/1", "way/2"]);
    expect(r.plan.openItems).toEqual([{ text: "Startzeiten buchen", day: 2 }]);
    expect(r.plan.header.model).toBe("claude-sonnet-5-5");
    expect(Object.values(r.issues).every((n) => n === 0)).toBe(true);
  });

  it("dates are null for undated trips", () => {
    const r = run(llmPlan(3), storedFor(3, null));
    expect(r.ok && r.plan.days.every((d) => d.date === null)).toBe(true);
  });

  it("fails on a wrong day count or numbering", () => {
    expect(run(llmPlan(2))).toEqual({ ok: false, reason: "day_count" });
    const dup = llmPlan(3);
    dup.days[2] = llmDay(2);
    expect(run(dup)).toEqual({ ok: false, reason: "day_count" });
  });

  it("sorts days given out of order", () => {
    const p = llmPlan(3);
    p.days.reverse();
    const r = run(p);
    expect(r.ok && r.plan.days.map((d) => d.n)).toEqual([1, 2, 3]);
  });

  it("drops unknown refs but keeps the activity", () => {
    const p = llmPlan(3);
    p.days[0].stops[0].acts[0].ref = "p99";
    const r = run(p);
    if (!r.ok) throw new Error();
    expect(r.issues.invalid_ref).toBe(1);
    expect(r.plan.days[0].stops[0].acts[0]).toEqual({ at: "09:00", kind: "sport", text: "Runde 1" });
  });

  it("drops bad times, pads H:MM, truncates long text, keeps first best, maps unknown kinds", () => {
    const p = llmPlan(3);
    p.days[0] = llmDay(1, {
      best: true,
      title: "x".repeat(100),
      stops: [{ place: "Melk", from: "7:00", to: "25:00", acts: [{ at: "noon", kind: "relax" as never, text: "y".repeat(250) }] }],
    });
    p.days[1].best = true;
    const r = run(p);
    if (!r.ok) throw new Error(r.reason);
    const d = r.plan.days[0];
    expect(d.stops[0]).toMatchObject({ place: "Melk", from: "07:00" });
    expect(d.stops[0].to).toBeUndefined();
    expect(d.stops[0].acts[0].at).toBeUndefined();
    expect(d.stops[0].acts[0].kind).toBe("do");
    expect(d.stops[0].acts[0].text).toHaveLength(200);
    expect(d.stops[0].acts[0].text.endsWith("…")).toBe(true);
    expect(d.title).toHaveLength(80);
    expect(r.issues).toMatchObject({ bad_time: 2, truncated: 2, extra_best: 1 });
    expect(r.plan.days.filter((x) => x.best).map((x) => x.n)).toEqual([1]);
  });

  it("counts window violations, keeps fixed only when true, falls back on empty text/places", () => {
    const p = llmPlan(3);
    p.days[0] = llmDay(1, {
      title: "",
      stops: [
        { place: "", from: "07:00", to: "12:00", fixed: true, acts: [{ at: "13:00", kind: "see", text: "Stift" }, { kind: "sport", text: "", ref: "p3" }, { kind: "see", text: " " }] },
        { place: "Bord", fixed: false, acts: [] },
      ],
    });
    p.days[1] = llmDay(2, { stops: [] });
    const r = run(p);
    if (!r.ok) throw new Error(r.reason);
    const [s1, s2] = r.plan.days[0].stops;
    expect(r.issues.window_violation).toBe(1);
    expect(s1.place).toBe("Costa del Sol");
    expect(s1.fixed).toBe(true);
    expect(s1.acts.map((a) => a.text)).toEqual(["Stift", "Cala"]); // empty text with ref -> place name; empty without -> dropped
    expect("fixed" in s2).toBe(false);
    expect(r.plan.days[0].title).toBe("Costa del Sol");
    expect(r.plan.days[1].stops).toEqual([{ place: "Tag 2", acts: [] }]);
  });

  it("enforces list limits and drops invalid open-item days", () => {
    const p = llmPlan(3, {
      notes: Array.from({ length: 12 }, (_, i) => ({ kind: "tip" as const, text: `n${i}` })),
      open: [{ text: "a", day: 9 }, { text: "" }],
      packing: ["Hut", "hut", ...Array.from({ length: 20 }, (_, i) => `p${i}`)],
    });
    const r = run(p);
    if (!r.ok) throw new Error(r.reason);
    expect(r.plan.notes).toHaveLength(10);
    expect(r.plan.openItems).toEqual([{ text: "a" }]);
    expect(r.plan.packing).toHaveLength(15);
    expect(r.plan.packing.filter((x) => x.toLowerCase() === "hut")).toHaveLength(1);
  });
});
