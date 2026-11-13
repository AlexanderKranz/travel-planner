import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { legChanged, stepLines } from "./steps";

const messages = (loc: string) => JSON.parse(readFileSync(join(__dirname, `../../../messages/${loc}.json`), "utf8")).tours.steps;

describe("stepLines", () => {
  it("maps ORS types to message keys, with the street only when named", () => {
    expect(stepLines([[11, "", 32, 0], [1, "Stephansplatz", 85, 3], [10, "", 0, 9]])).toEqual([
      { key: "depart", values: { name: "" }, metres: 32 },
      { key: "rightOnto", values: { name: "Stephansplatz" }, metres: 85 },
      { key: "arrive", values: { name: "" }, metres: 0 },
    ]);
  });

  it("merges the roundabout exit (type 8) into the entry, with or without an exit number", () => {
    expect(stepLines([[7, "Ring", 200, 0, 2], [8, "Ring", 100, 1]])).toEqual([{ key: "roundaboutOnto", values: { name: "Ring", exit: 2 }, metres: 200 }]);
    expect(stepLines([[7, "", 50, 0]])).toEqual([{ key: "roundaboutNoExit", values: { name: "" }, metres: 50 }]);
  });

  it("every key it can produce exists in de and en", () => {
    const all = [...Array(14).keys()].flatMap((type) =>
      ["", "Gasse"].flatMap((name) => stepLines(type === 7 ? [[7, name, 1, 0, 1], [7, name, 1, 0]] : [[type, name, 1, 0]])),
    );
    const keys = new Set(all.map((l) => l.key));
    for (const loc of ["de", "en"]) for (const k of keys) expect(messages(loc), `${loc}: ${k}`).toHaveProperty(k);
  });
});

describe("legChanged", () => {
  it("flags more than 5 % or 50 m, whichever is larger", () => {
    expect(legChanged(2, 2.09)).toBe(false);
    expect(legChanged(2, 2.11)).toBe(true);
    expect(legChanged(0.3, 0.34)).toBe(false); // 40 m < 50 m
    expect(legChanged(0.3, 0.36)).toBe(true);
    expect(legChanged(null, 5)).toBe(false);
  });
});
