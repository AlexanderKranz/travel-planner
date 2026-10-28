import { describe, expect, it } from "vitest";
import recorded from "../../evals/recorded/group-text.json";
import { GroupParse } from "@/lib/domain/group-text";
import {
  groupPartySize,
  normalizeParse,
  resolveGroup,
  resolveTravellerAge,
  summaryFacts,
  tripGroupSource,
  WireGroupParse,
  type GroupSource,
} from "./group-text";

/** Recorded Haiku responses (evals/recorded/group-text.json, `npm run evals:group-text`). */
const samples = recorded.samples as { text: string; wire: unknown }[];
const parseOf = (text: string) => {
  const s = samples.find((x) => x.text.startsWith(text));
  if (!s) throw new Error(`no recording for ${text}`);
  return normalizeParse(WireGroupParse.parse(s.wire));
};
const wire = (over: Partial<WireGroupParse["travellers"][number]> = {}) => ({
  count: 1, ageMode: null, age: null, ageOffset: null, label: null, role: null, ...over,
});

const DATE = "2027-03-13";
const MY_BIRTHDATE = "1981-03-13"; // 46 on DATE
const none = { entries: [], traitKeys: [] } satisfies Pick<GroupSource, "entries" | "traitKeys">;

describe("recorded Haiku responses", () => {
  it("every recording is valid wire output and normalises to a valid parse", () => {
    expect(samples.length).toBeGreaterThanOrEqual(8);
    for (const s of samples) {
      const w = WireGroupParse.safeParse(s.wire);
      expect(w.success, s.text).toBe(true);
      expect(GroupParse.safeParse(normalizeParse(w.data!)).success, s.text).toBe(true);
    }
  });

  it('"5 Freunde, alle in meinem Alter" is five adults of my age', () => {
    expect(parseOf("Wir sind 5 Freunde").travellers).toEqual([
      { count: 5, ageMode: "relativeToMe", ageOffset: 0, role: "adult", label: "Freunde" },
    ]);
  });

  it("resolves relative ages with the profile birthdate: 5 adults, about 46", () => {
    const r = resolveGroup({ ...none, description: "x", parse: parseOf("Wir sind 5 Freunde") }, DATE, MY_BIRTHDATE);
    expect(r.source).toBe("parse");
    expect(r.size).toBe(5);
    expect(r.summary).toMatchObject({ total: 5, adults: 5 });
    expect(summaryFacts(r)).toEqual({ counts: r.summary, age: { kind: "known", min: 46, max: 46, approx: true } });
  });

  it('without a birthdate the age stays "about my age", with no number', () => {
    const r = resolveGroup({ ...none, description: "x", parse: parseOf("Wir sind 5 Freunde") }, DATE, null);
    expect(r.rows[0].age).toEqual({ status: "aboutMyAge" });
    expect(summaryFacts(r).age).toEqual({ kind: "aboutMe" });
    expect(r.summary.adults).toBe(5);
  });

  it("keeps exact ages and roles of a family", () => {
    const r = resolveGroup({ ...none, description: "x", parse: parseOf("Family: 2 parents") }, DATE, null);
    expect(r.size).toBe(5);
    expect(r.summary).toEqual({ total: 5, adults: 2, children: 3, toddlers: 0, unknown: 0 });
    expect(summaryFacts(r).age).toEqual({ kind: "known", min: 4, max: 40, approx: true });
  });

  it("an offset turns into an age relative to the profile age", () => {
    const r = resolveGroup({ ...none, description: "x", parse: parseOf("Ben ist 5 Jahre") }, DATE, MY_BIRTHDATE);
    const ben = r.rows.find((x) => x.label === "Ben")!;
    expect(ben.age).toEqual({ status: "known", age: 41, approximate: true });
    expect(r.size).toBe(4);
  });

  it("a text without people has no travellers, only notes", () => {
    const p = parseOf("Wir spielen alle gern Golf");
    expect(p.notes.length).toBeGreaterThan(0);
  });
});

describe("normalizeParse", () => {
  it("drops unknown modes and roles, clamps numbers, requires an age for exact/approx", () => {
    const p = normalizeParse({
      v: 9,
      travellers: [
        wire({ count: 400, ageMode: "exact", age: 500, role: "boss" }),
        wire({ count: 2, ageMode: "exact", age: null }),
        wire({ count: 1, ageMode: "relativeToMe", ageOffset: -99, label: "  Ben \n x " }),
        wire({ count: Number.NaN }),
      ],
      notes: ["  vegan ", "VEGAN", "", "x".repeat(300)],
    });
    expect(p.travellers).toEqual([
      { count: 50, ageMode: "exact", age: 120 },
      { count: 2 },
      { count: 1, ageMode: "relativeToMe", ageOffset: -60, label: "Ben x" },
    ]);
    expect(p.notes).toHaveLength(2);
    expect(p.notes[1]).toHaveLength(200);
  });

  it("defaults a missing offset to 0", () => {
    expect(normalizeParse({ v: 1, travellers: [wire({ ageMode: "relativeToMe" })], notes: [] }).travellers[0]).toMatchObject({ ageOffset: 0 });
  });
});

describe("resolveTravellerAge", () => {
  const rel = (ageOffset: number) => ({ count: 1, ageMode: "relativeToMe" as const, ageOffset });
  it("is computed from the birthdate on the travel date, never below 0", () => {
    expect(resolveTravellerAge(rel(0), DATE, MY_BIRTHDATE)).toEqual({ status: "known", age: 46, approximate: true });
    expect(resolveTravellerAge(rel(-60), DATE, MY_BIRTHDATE)).toEqual({ status: "known", age: 0, approximate: true });
    expect(resolveTravellerAge(rel(0), "2028-03-12", MY_BIRTHDATE)).toMatchObject({ age: 46 });
    expect(resolveTravellerAge(rel(0), "2028-03-13", MY_BIRTHDATE)).toMatchObject({ age: 47 });
  });
  it("without a birthdate: about my age for offset 0, unknown otherwise", () => {
    expect(resolveTravellerAge(rel(0), DATE, null)).toEqual({ status: "aboutMyAge" });
    expect(resolveTravellerAge(rel(-5), DATE, null)).toEqual({ status: "unknown" });
  });
  it("a birthdate after the travel date is treated as unknown", () => {
    expect(resolveTravellerAge(rel(0), DATE, "2030-01-01")).toEqual({ status: "aboutMyAge" });
  });
});

describe("resolution order [D5]", () => {
  const parse = GroupParse.parse({ v: 1, travellers: [{ count: 5, ageMode: "relativeToMe", ageOffset: 0, role: "adult" }], notes: ["vegan"] });
  const entries: GroupSource["entries"] = [
    { kind: "member", isSelf: true },
    { kind: "composition", count: 2, age: { ageMode: "exact", age: 30 } },
  ];

  it("saved entries beat the parse, which beats the raw text", () => {
    const text = "Wir sind 5 Freunde";
    const a = resolveGroup({ entries, traitKeys: [], description: text, parse }, DATE, MY_BIRTHDATE);
    expect(a.source).toBe("entries");
    expect(a.size).toBe(3);
    const b = resolveGroup({ ...none, description: text, parse }, DATE, MY_BIRTHDATE);
    expect(b.source).toBe("parse");
    expect(b.size).toBe(5);
    const c = resolveGroup({ ...none, description: text, parse: null }, DATE, MY_BIRTHDATE);
    expect(c.source).toBe("text");
    expect(c.size).toBe(0);
    expect(c.rows).toEqual([]);
    expect(c.notes).toBe(text);
  });

  it("notes: group notes + parse notes; raw text (cut) only without a parse", () => {
    expect(resolveGroup({ ...none, notes: "Buggy", description: "t", parse }, DATE, null).notes).toBe("Buggy; vegan");
    const long = "a".repeat(2000);
    expect(resolveGroup({ ...none, description: long, parse: null }, DATE, null).notes).toHaveLength(600);
    expect(resolveGroup({ ...none, description: "  " }, DATE, null).notes).toBeUndefined();
  });

  it("entries keep working unchanged without any text", () => {
    const r = resolveGroup({ entries, traitKeys: [], notes: "n" }, DATE, MY_BIRTHDATE);
    expect(r.notes).toBe("n");
    expect(r.rows.map((x) => x.age.status)).toEqual(["known", "known"]);
  });

  it("a parse without travellers falls back to the raw text", () => {
    const empty = GroupParse.parse({ v: 1, travellers: [], notes: ["golf"] });
    const r = resolveGroup({ ...none, description: "Wir spielen Golf", parse: empty }, DATE, null);
    expect(r.source).toBe("text");
    expect(r.notes).toBe("Wir spielen Golf");
  });
});

describe("party size", () => {
  const parse = GroupParse.parse({ v: 1, travellers: [{ count: 2 }, { count: 3 }], notes: [] });
  it("comes from the same resolution", () => {
    expect(groupPartySize(resolveGroup({ ...none, description: "t", parse }, DATE, null))).toBe(5);
    expect(groupPartySize(resolveGroup({ entries: [{ kind: "member" }, { kind: "composition", count: 4 }], traitKeys: [] }, DATE, null))).toBe(5);
  });
  it("is null when only text is known, and without a group", () => {
    expect(groupPartySize(resolveGroup({ ...none, description: "Wir sind viele" }, DATE, null))).toBeNull();
    expect(groupPartySize(null)).toBeNull();
  });
});

describe("one-off group of a trip", () => {
  it("has no source without text and structure", () => {
    expect(tripGroupSource({ groupStructure: [] })).toBeNull();
  });
  it("text only: parse resolves", () => {
    const parse = GroupParse.parse({ v: 1, travellers: [{ count: 2, ageMode: "relativeToMe", ageOffset: 0 }], notes: [] });
    const src = tripGroupSource({ groupText: "Ich und Ben", groupStructure: [], groupParse: parse })!;
    const r = resolveGroup(src, DATE, MY_BIRTHDATE);
    expect(r).toMatchObject({ source: "parse", size: 2 });
  });
  it("the corrected structure wins over the parse and advances stated ages from ageAsOf", () => {
    const parse = GroupParse.parse({ v: 1, travellers: [{ count: 5 }], notes: [] });
    const src = tripGroupSource({
      groupText: "Ich und Ben",
      groupStructure: [{ count: 2, age: { ageMode: "approx", age: 40 }, ageAsOf: "2025-03-13" }],
      groupParse: parse,
    })!;
    const r = resolveGroup(src, DATE, null);
    expect(r.source).toBe("entries");
    expect(r.size).toBe(2);
    expect(r.rows[0].age).toEqual({ status: "known", age: 42, approximate: true });
  });
  it("without a parse (AI off) the text goes in as notes", () => {
    const r = resolveGroup(tripGroupSource({ groupText: "Ich und Ben", groupStructure: [] })!, DATE, null);
    expect(r).toMatchObject({ source: "text", notes: "Ich und Ben", size: 0 });
  });
});
