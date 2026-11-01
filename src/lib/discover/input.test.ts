import { describe, expect, it, vi } from "vitest";
import type { GroupSource } from "@/lib/group-text";
import type { TripPurpose } from "@/lib/domain/purpose";
import { IDEAS_PROMPT_VERSION, MODEL_IDEAS } from "@/lib/domain/ai";
import { ideasInputHash } from "./hash";
import { ageDateFor, buildIdeaInput, mentionsFlight, monthStartOnOrAfter, withoutFlightSentences, type IdeaInputSource } from "./input";

vi.mock("server-only", () => ({}));

const purpose = (o: Partial<TripPurpose> = {}): TripPurpose => ({
  id: "p1",
  name: "Golf",
  guided: { interests: ["golf", "flat courses"], pace: "relaxed" },
  constraints: [],
  tags: null,
  createdAt: "t",
  updatedAt: "t",
  ...o,
});

const src = (o: Partial<IdeaInputSource> = {}): IdeaInputSource => ({
  lang: "de",
  purpose: purpose(),
  months: [3],
  origins: ["FRA"],
  radiusKm: 2128,
  group: null,
  profileBirthdate: null,
  today: "2026-11-01",
  ...o,
});

describe("buildIdeaInput", () => {
  it("compact input: lang, tags, months, airport cities, radius hint, count 8", () => {
    const i = buildIdeaInput(src());
    expect(i).toMatchObject({ v: 1, lang: "de", months: [3], from: ["Frankfurt am Main"], radiusKm: 2128, count: 8 });
    // Typed custom interests are used raw while there are no tags (same rule as the plan input).
    expect(i.purpose).toMatchObject({ interests: ["golf"], custom: ["flat courses"] });
    expect(i.exclude).toBeUndefined();
  });

  it("E8: a flight limit in the purpose never reaches the model as a task", () => {
    const i = buildIdeaInput(
      src({
        purpose: purpose({
          constraints: ["max 3 h flight from FRA", "Flug höchstens 2,5 Stunden", "golf every day"],
          text: "Golf with a friend. We fly max 3 h. Nice weather please.",
          tags: null,
        }),
      }),
    );
    expect(i.purpose.hard).toEqual(["golf every day"]);
    expect(i.purpose.summary).toBe("Golf with a friend. Nice weather please.");
    expect(JSON.stringify(i)).not.toMatch(/flight|flug|fly/i);
  });

  it("E8 with tags: hard and soft entries that mention a flight are removed, other text stays", () => {
    const i = buildIdeaInput(
      src({
        purpose: purpose({
          tags: {
            v: 1,
            interests: ["golf", "beach"],
            custom: ["flat courses"],
            hard: ["max 3 h flight", "36 holes on one day"],
            soft: ["short flight if possible", "sea view"],
            summary: "Golf trip. Direct flight preferred.",
          },
        }),
      }),
    );
    expect(i.purpose).toMatchObject({ interests: ["golf", "beach"], custom: ["flat courses"], hard: ["36 holes on one day"], soft: ["sea view"], summary: "Golf trip." });
  });

  it("without tags the text is cut to 600 characters (phase 3 D7) and the raw text is not sent as a whole", () => {
    const i = buildIdeaInput(src({ purpose: purpose({ text: "a".repeat(2000) }) }));
    expect(i.purpose.summary!.length).toBe(600);
  });

  it("no airports: no from, no radius hint", () => {
    const i = buildIdeaInput(src({ origins: [], radiusKm: 2128 }));
    expect(i.from).toBeUndefined();
    expect(i.radiusKm).toBeUndefined();
  });

  it("flight limit absent: from but no radius", () => {
    const i = buildIdeaInput(src({ radiusKm: undefined }));
    expect(i.from).toEqual(["Frankfurt am Main"]);
    expect(i.radiusKm).toBeUndefined();
  });

  it("no months, no group: both absent", () => {
    const i = buildIdeaInput(src({ months: [] }));
    expect(i.months).toBeUndefined();
    expect(i.group).toBeUndefined();
  });

  it("months are sorted, unique and at most 3", () => {
    expect(buildIdeaInput(src({ months: [12, 3, 3, 1, 7] })).months).toEqual([1, 3, 7]);
  });

  it("E3: counts only, toddlers from the birthdate, no names, ages or notes", () => {
    const group: GroupSource = {
      entries: [
        { kind: "member", count: 1, name: "Anna", birthdate: "1985-06-15", notes: "vegetarian" },
        { kind: "member", count: 1, name: "Ben", birthdate: "1987-02-01" },
        { kind: "member", count: 1, name: "Mia", birthdate: "2025-01-10" },
      ],
      traitKeys: [],
      notes: "private group note",
    } as unknown as GroupSource;
    const i = buildIdeaInput(src({ group, months: [12], origins: [], radiusKm: undefined, today: "2026-11-01" }));
    expect(i.group).toEqual({ adults: 2, children: 0, toddlers: 1 });
    const json = JSON.stringify(i);
    expect(json).not.toMatch(/Anna|Ben|Mia|vegetarian|private|1985|birth/);
  });

  it("a text-only group has no counts and is omitted", () => {
    const group = { entries: [], traitKeys: [], description: "5 Freunde, alle in meinem Alter", parse: null } as GroupSource;
    expect(buildIdeaInput(src({ group })).group).toBeUndefined();
  });

  it("round 2 carries the exclusions", () => {
    expect(buildIdeaInput(src({ exclude: ["Marbella", "Palma"] })).exclude).toEqual(["Marbella", "Palma"]);
  });
});

describe("flight sentences", () => {
  it("mentionsFlight catches limits and flight words", () => {
    for (const s of ["max 3 h flight", "Flug höchstens 2,5 Stunden", "no long flights", "fly direct"]) expect(mentionsFlight(s), s).toBe(true);
    for (const s of ["golf every day", "flat courses", "36 holes"]) expect(mentionsFlight(s), s).toBe(false);
  });
  it("withoutFlightSentences keeps the rest", () => {
    expect(withoutFlightSentences("Relaxed. Max 2 h flight. Sea view!")).toBe("Relaxed. Sea view!");
  });
});

describe("age reference date (rule 4)", () => {
  it("first day of the next occurrence of the first month, else today", () => {
    expect(monthStartOnOrAfter(12, "2026-11-01")).toBe("2026-12-01");
    expect(monthStartOnOrAfter(3, "2026-11-01")).toBe("2027-03-01");
    expect(monthStartOnOrAfter(11, "2026-11-20")).toBe("2026-11-01");
    expect(ageDateFor([3, 12], "2026-11-01")).toBe("2027-03-01");
    expect(ageDateFor([], "2026-11-01")).toBe("2026-11-01");
  });
});

describe("ideasInputHash (D6, E9)", () => {
  it("is sha256 hex and stable", () => {
    const a = ideasInputHash(buildIdeaInput(src()));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(ideasInputHash(buildIdeaInput(src()))).toBe(a);
  });
  it("E9: the same input in de and en has different hashes (a German list is never served to an English request)", () => {
    expect(ideasInputHash(buildIdeaInput(src({ lang: "de" })))).not.toBe(ideasInputHash(buildIdeaInput(src({ lang: "en" }))));
  });
  it("covers tags, months, airports, radius, group and exclusions", () => {
    const base = ideasInputHash(buildIdeaInput(src()));
    expect(ideasInputHash(buildIdeaInput(src({ months: [4] })))).not.toBe(base);
    expect(ideasInputHash(buildIdeaInput(src({ origins: ["MUC"] })))).not.toBe(base);
    expect(ideasInputHash(buildIdeaInput(src({ radiusKm: 1330 })))).not.toBe(base);
    expect(ideasInputHash(buildIdeaInput(src({ exclude: ["Marbella"] })))).not.toBe(base);
    expect(ideasInputHash(buildIdeaInput(src({ purpose: purpose({ guided: { interests: ["beach"] } }) })))).not.toBe(base);
  });
  it("includes the prompt version and the model (changing either invalidates saved lists)", () => {
    expect(IDEAS_PROMPT_VERSION).toBe("ideas-3");
    expect(MODEL_IDEAS).toBe("claude-haiku-5-5");
  });
});

describe("flight and distance limits never reach the model (review round)", () => {
  it.each(["weniger als 1500 km entfernt", "maximal 2 Stunden fliegen", "nicht länger als 3 Stunden im Flieger", "no more than 2.5h in the air", "gute Anreise", "near an airport", "within 3 hours"])(
    "mentionsFlight: %s",
    (s) => expect(mentionsFlight(s)).toBe(true),
  );
  it("custom interests (guided and tag) are filtered too", () => {
    const i = buildIdeaInput(src({ purpose: purpose({ guided: { interests: ["golf", "Direktflug unter 2 Stunden", "flat courses"] } }) }));
    expect(i.purpose.custom).toEqual(["flat courses"]);
    const tagged = buildIdeaInput(src({ purpose: purpose({ tags: { v: 1, interests: ["golf"], custom: ["Flugzeit kurz", "links courses"], hard: [], soft: [], summary: "" } }) }));
    expect(tagged.purpose.custom).toEqual(["links courses"]);
  });
  it("airport codes distinguish the hash (LHR vs LGW) without being a separate model fact", () => {
    const a = buildIdeaInput(src({ origins: ["LHR"] }));
    const b = buildIdeaInput(src({ origins: ["LGW"] }));
    expect(a.from).toEqual(b.from);
    expect(ideasInputHash(a)).not.toBe(ideasInputHash(b));
  });
});

describe("drive searches (find-destinations-drive section 4)", () => {
  const drive = { homeName: "Frankfurt am Main, Hesse, Germany", homeCell: "50.11,8.68" };
  it("from = the home place, travel = drive, the hint radius, a home cell, no airport codes", () => {
    const i = buildIdeaInput(src({ origins: [], radiusKm: 360, drive }));
    expect(i).toMatchObject({ from: ["Frankfurt am Main, Hesse, Germany"], travel: "drive", radiusKm: 360, homeCell: "50.11,8.68" });
    expect(i.fromIata).toBeUndefined();
  });
  it("a flight input stays byte-identical: none of the new keys appear", () => {
    const i = buildIdeaInput(src());
    expect(Object.keys(i)).not.toContain("travel");
    expect(Object.keys(i)).not.toContain("homeCell");
    expect(JSON.stringify(i)).toBe(JSON.stringify(buildIdeaInput(src({ drive: undefined }))));
  });
  it("the hash differs by mode, limit (through the radius) and home cell", () => {
    const d = (o: Partial<IdeaInputSource> = {}) => ideasInputHash(buildIdeaInput(src({ origins: [], radiusKm: 360, drive, ...o })));
    const base = d();
    expect(d({ radiusKm: 720 })).not.toBe(base);
    expect(d({ drive: { ...drive, homeCell: "54.10,10.80" } })).not.toBe(base);
    expect(ideasInputHash(buildIdeaInput(src({ origins: [], radiusKm: 360 })))).not.toBe(base); // no airports, no drive
    expect(ideasInputHash(buildIdeaInput(src()))).not.toBe(base);
  });
  it("a drive limit in the purpose is stripped like a flight limit; scenic drives stay", () => {
    for (const s of ["4 Stunden Autofahrt", "max. 3 h Fahrt", "4 h drive", "höchstens 2 Stunden Fahrzeit", "3 hours by car", "4-hour drive"]) expect(mentionsFlight(s)).toBe(true);
    for (const s of ["scenic drives", "schöne Fahrten am Meer", "Fahrradtour", "Golf spielen, 4 Plätze"]) expect(mentionsFlight(s)).toBe(false);
    const i = buildIdeaInput(src({ purpose: purpose({ constraints: ["4 Stunden Autofahrt", "scenic drives"] }) }));
    expect(i.purpose.hard).toEqual(["scenic drives"]);
  });
});
