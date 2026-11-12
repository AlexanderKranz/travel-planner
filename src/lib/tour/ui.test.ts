import { describe, expect, it } from "vitest";
import { TourDraft, TourInput, type TourResult } from "@/lib/domain/tour";
import { BELVEDERE, HOFBURG, NASCHMARKT, STEPHANSDOM, WIEN_CITY } from "./fixtures.test-data";
import {
  applyLegSheet,
  applyProposal,
  canAddPlace,
  choicesWith,
  draftSignature,
  durationParts,
  emptyForm,
  formatKm,
  formFromInput,
  formProblem,
  formReady,
  isTaken,
  resultFitsInput,
  isOutdated,
  issueKeys,
  moveItem,
  openLegSheet,
  orderedCoords,
  resultRows,
  roundMetres,
  sheetMode,
  toDraft,
  withMode,
  type FormPoint,
  type TourForm,
} from "./ui";

const fp = (p: { key: string; name: string; lat: number; lon: number }, extra: Partial<FormPoint> = {}): FormPoint => ({
  key: p.key,
  name: p.name,
  lat: p.lat,
  lon: p.lon,
  ...extra,
});

const form = (over: Partial<TourForm> = {}): TourForm => ({
  ...emptyForm(),
  places: [fp(STEPHANSDOM, { ref: "r1" }), fp(HOFBURG, { ref: "r2" })],
  ...over,
});

const input = TourInput.parse({
  city: WIEN_CITY,
  places: [STEPHANSDOM, { ...HOFBURG, dwellMin: 60 }, NASCHMARKT],
  start: BELVEDERE,
  end: "start",
  startTime: "10:00",
});

describe("toDraft", () => {
  it("sends keys and refs only, with the settings that are set", () => {
    const d = toDraft(form({ city: fp(WIEN_CITY), startTime: "09:30", endBy: "13:00", maxMin: "180", title: "  Altstadt " }));
    expect(d).toEqual({
      title: "Altstadt",
      city: { key: WIEN_CITY.key },
      places: [
        { key: STEPHANSDOM.key, ref: "r1" },
        { key: HOFBURG.key, ref: "r2" },
      ],
      order: "optimize",
      mode: "foot",
      route: "fastest",
      dwellDefaultMin: 30,
      startTime: "09:30",
      endBy: "13:00",
      maxMin: 180,
    });
    expect(TourDraft.safeParse(d).success).toBe(true);
  });

  it("drops endBy without a start time and overrides of points no longer in the tour", () => {
    const d = toDraft(
      form({
        endBy: "12:00",
        legOverrides: {
          [`${STEPHANSDOM.key}>${HOFBURG.key}`]: { mode: "car", route: "fastest" },
          [`${STEPHANSDOM.key}>${NASCHMARKT.key}`]: { mode: "car", route: "fastest" },
        },
      }),
    );
    expect(d.endBy).toBeUndefined();
    expect(Object.keys(d.legOverrides ?? {})).toEqual([`${STEPHANSDOM.key}>${HOFBURG.key}`]);
  });

  it("writes the end as round trip, other place or open", () => {
    expect(toDraft(form({ start: fp(BELVEDERE), endKind: "start" })).end).toBe("start");
    expect(toDraft(form({ endKind: "start" })).end).toBeUndefined();
    expect(toDraft(form({ endKind: "other", end: fp(NASCHMARKT, { ref: "r3" }) })).end).toEqual({ key: NASCHMARKT.key, ref: "r3" });
    expect(toDraft(form({ endKind: "none", end: fp(NASCHMARKT) })).end).toBeUndefined();
  });

  it("falls back to an allowed route option", () => {
    expect(toDraft(form({ mode: "car", route: "green" })).route).toBe("fastest");
  });
});

describe("formFromInput", () => {
  it("round-trips a stored input to the same draft (without refs)", () => {
    const f = formFromInput(input, null);
    expect(f.endKind).toBe("start");
    expect(f.places[1].dwellMin).toBe(60);
    const d = TourDraft.parse(toDraft(f));
    expect(d.places.map((p) => p.key)).toEqual(input.places.map((p) => p.key));
    expect(d.end).toBe("start");
    expect(d.startTime).toBe("10:00");
  });
});

describe("outdated detection", () => {
  it("ignores refs and key order in the signature", () => {
    const a = toDraft(form());
    const b = { ...toDraft(form({ places: [fp(STEPHANSDOM), fp(HOFBURG)] })) };
    expect(draftSignature(a)).toBe(draftSignature(b));
    expect(draftSignature({ mode: "foot", places: a.places } as never)).toBe(draftSignature({ places: a.places, mode: "foot" } as never));
  });

  it("is outdated without a result, when the server says so, or after an edit", () => {
    const sig = draftSignature(toDraft(form()));
    expect(isOutdated({ hasResult: false, serverOutdated: false, savedSignature: sig, signature: sig })).toBe(true);
    expect(isOutdated({ hasResult: true, serverOutdated: true, savedSignature: sig, signature: sig })).toBe(true);
    expect(isOutdated({ hasResult: true, serverOutdated: false, savedSignature: sig, signature: sig })).toBe(false);
    const edited = draftSignature(toDraft(form({ dwellDefaultMin: 45 })));
    expect(isOutdated({ hasResult: true, serverOutdated: false, savedSignature: sig, signature: edited })).toBe(true);
  });
});

describe("form helpers", () => {
  it("needs 2 places and a complete end", () => {
    expect(formReady(form({ places: [fp(STEPHANSDOM)] }))).toBe(false);
    expect(formReady(form())).toBe(true);
    expect(formReady(form({ endKind: "other" }))).toBe(false);
  });

  it("names what blocks the form", () => {
    expect(formProblem(form({ places: [fp(STEPHANSDOM)] }))).toBe("places");
    expect(formProblem(form({ endKind: "other" }))).toBe("end");
    expect(formProblem(form({ minMin: "180", maxMin: "120" }))).toBe("durations");
    expect(formProblem(form({ minMin: "60", maxMin: "120" }))).toBeNull();
  });

  it("ignores an end that is not selected", () => {
    expect(isTaken(form({ endKind: "none", end: fp(NASCHMARKT) }), NASCHMARKT.key)).toBe(false);
    expect(isTaken(form({ endKind: "other", end: fp(NASCHMARKT) }), NASCHMARKT.key)).toBe(true);
  });

  it("withholds a stored result that names points no longer in the input", () => {
    expect(resultFitsInput(input, { order: [BELVEDERE.key, STEPHANSDOM.key, BELVEDERE.key] })).toBe(true);
    expect(resultFitsInput(input, { order: [STEPHANSDOM.key, "osm:n404"] })).toBe(false);
  });

  it("moves items and keeps the edges", () => {
    expect(moveItem([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(moveItem([1, 2, 3], 2, -1)).toEqual([1, 3, 2]);
    expect(moveItem([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
  });

  it("does not add a point twice or beyond the cap", () => {
    expect(canAddPlace(form(), STEPHANSDOM.key)).toBe(false);
    expect(canAddPlace(form({ start: fp(BELVEDERE) }), BELVEDERE.key)).toBe(false);
    expect(canAddPlace(form(), NASCHMARKT.key)).toBe(true);
    const ten = Array.from({ length: 10 }, (_, i) => fp({ key: `osm:n${i}`, name: `P${i}`, lat: 48, lon: 16 }));
    expect(canAddPlace(form({ places: ten }), NASCHMARKT.key)).toBe(false);
  });

  it("keeps a stored value among the choices", () => {
    expect(choicesWith([15, 30], 20)).toEqual([15, 20, 30]);
    expect(choicesWith([15, 30], 30)).toEqual([15, 30]);
  });

  it("switching the mode keeps an allowed route and falls back otherwise", () => {
    expect(withMode(form({ route: "shortest" }), "car").route).toBe("shortest");
    expect(withMode(form({ route: "green" }), "car").route).toBe("fastest");
  });

  it("reads unknown point keys from issues", () => {
    expect(issueKeys([{ path: "gfy:1" }, { path: "gfy:1" }, { path: "gfy:2" }])).toEqual(["gfy:1", "gfy:2"]);
    expect(issueKeys(undefined)).toEqual([]);
  });
});

describe("formatting", () => {
  it("splits durations", () => {
    expect(durationParts(45)).toEqual({ key: "durationMin", values: { h: 0, m: 45 } });
    expect(durationParts(120)).toEqual({ key: "durationH", values: { h: 2, m: 0 } });
    expect(durationParts(125)).toEqual({ key: "durationHm", values: { h: 2, m: 5 } });
  });

  it("formats km per locale with one decimal", () => {
    expect(formatKm(4.24, "de")).toBe("4,2");
    expect(formatKm(4.24, "en")).toBe("4.2");
    expect(formatKm(12.34, "en")).toBe("12.3");
  });

  it("rounds metres for the nearby chips", () => {
    expect(roundMetres(3)).toBe(10);
    expect(roundMetres(124)).toBe(120);
    expect(roundMetres(1260)).toBe(1300);
  });
});

describe("leg sheet", () => {
  const f = form({ mode: "foot", route: "fastest" });
  const key = `${STEPHANSDOM.key}>${HOFBURG.key}`;

  it("opens with the tour setting or the leg override", () => {
    expect(openLegSheet(STEPHANSDOM.key, HOFBURG.key, f)).toEqual({ key, from: STEPHANSDOM.key, to: HOFBURG.key, mode: "foot", route: "fastest" });
    const o = openLegSheet(STEPHANSDOM.key, HOFBURG.key, { ...f, legOverrides: { [key]: { mode: "cycling", route: "quiet" } } });
    expect([o.mode, o.route]).toEqual(["cycling", "quiet"]);
  });

  it("keeps an allowed route when the mode changes, else the mode's first option", () => {
    const s = openLegSheet(STEPHANSDOM.key, HOFBURG.key, { ...f, route: "quiet" });
    expect(sheetMode(s, "cycling").route).toBe("quiet");
    expect(sheetMode(s, "car").route).toBe("fastest");
  });

  it("stores an override and removes it when it equals the tour", () => {
    const s = openLegSheet(STEPHANSDOM.key, HOFBURG.key, f);
    const set = applyLegSheet({}, { ...s, mode: "car", route: "no_highways" }, f);
    expect(set).toEqual({ [key]: { mode: "car", route: "no_highways" } });
    expect(applyLegSheet(set, s, f)).toEqual({});
  });
});

describe("proposals", () => {
  const f = form({ places: [fp(STEPHANSDOM, { dwellMin: 90 }), fp(HOFBURG, { dwellMin: 15 }), fp(NASCHMARKT)], order: "keep" });
  it("applies drop, dwell and optimize", () => {
    expect(applyProposal(f, { kind: "drop", key: HOFBURG.key, totalMin: 100 }).places.map((p) => p.key)).toEqual([STEPHANSDOM.key, NASCHMARKT.key]);
    expect(applyProposal(f, { kind: "dwell", totalMin: 100 }).places.map((p) => p.dwellMin)).toEqual([undefined, 15, undefined]);
    expect(applyProposal(f, { kind: "optimize", totalMin: 100 }).order).toBe("optimize");
  });
  it("never drops below 2 places", () => {
    const two = form();
    expect(applyProposal(two, { kind: "drop", key: HOFBURG.key, totalMin: 1 }).places).toHaveLength(2);
  });
});

describe("resultRows", () => {
  const result: TourResult = {
    v: 1,
    order: [BELVEDERE.key, STEPHANSDOM.key, HOFBURG.key, NASCHMARKT.key, BELVEDERE.key],
    legs: [
      { from: BELVEDERE.key, to: STEPHANSDOM.key, mode: "foot", route: "fastest", min: 20, km: 1.6, poly: null, s: "ok" },
      { from: STEPHANSDOM.key, to: HOFBURG.key, mode: "cycling", route: "fastest", min: 5, km: 0.7, poly: null, s: "ok" },
      { from: HOFBURG.key, to: NASCHMARKT.key, mode: "foot", route: "fastest", min: 12, km: 1, poly: null, s: "ok" },
      { from: NASCHMARKT.key, to: BELVEDERE.key, mode: "foot", route: "fastest", min: null, km: null, poly: null, s: "failed" },
    ],
    totalMin: null,
    fit: "none",
    sights: [{ key: "osm:n9", name: "Karlskirche", lat: 48.198, lon: 16.371, leg: 2, m: 80, cat: "place_of_worship" }],
    source: { ors: "2026-11-12T10:00:00Z" },
  };
  const times = [
    { arrive: "10:00", leave: "10:00" },
    { arrive: "10:20", leave: "10:50" },
    { arrive: "10:55", leave: "11:55" },
    { arrive: "12:07", leave: "12:37" },
    { arrive: "13:00", leave: "13:00" },
  ];

  it("names stops with roles, dwell and times", () => {
    const { stops } = resultRows(input, result, times);
    expect(stops.map((s) => [s.n, s.name, s.role, s.dwellMin])).toEqual([
      [1, "Belvedere", "start", 0],
      [2, "Stephansdom", "place", 30],
      [3, "Hofburg", "place", 60],
      [4, "Naschmarkt", "place", 30],
      [5, "Belvedere", "end", 0],
    ]);
    expect(stops[2]).toMatchObject({ arrive: "10:55", leave: "11:55" });
    expect(resultRows(input, result, null).stops[1].arrive).toBeUndefined();
  });

  it("marks overridden legs and assigns sights to their leg", () => {
    const { legs } = resultRows(input, result, null);
    expect(legs.map((l) => l.overridden)).toEqual([false, true, false, false]);
    expect(legs[2].sights.map((s) => s.name)).toEqual(["Karlskirche"]);
    expect(legs[0].sights).toEqual([]);
  });

  it("orders coordinates for the map and the Google link", () => {
    expect(orderedCoords(input, result.order).map((c) => c.key)).toEqual(result.order);
  });
});
