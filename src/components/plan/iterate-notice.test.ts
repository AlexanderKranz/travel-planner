import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { driveStopNames } from "./helpers";
import { ITERATE_NOTICES, NOTICE_KEY, readNotice, unchangedMessage } from "./iterate-notice";

const t = (key: string, v?: Record<string, string>) => `${key}${v?.places ? `:${v.places}` : ""}`;
const list = (items: string[]) => items.join(" & ");

describe("unchangedMessage", () => {
  it("uses the specific notice with the stop names", () => {
    expect(unchangedMessage({ notice: { code: "stops_capped", places: ["Linz", "Melk"] } }, t, list)).toBe("stopsCapped:Linz & Melk");
  });
  it("keeps the existing string notice", () => {
    expect(unchangedMessage({ notice: "places_not_loadable" }, t, list)).toBe("placesNotLoadable");
  });
  it("appends the model reply when there is no notice", () => {
    expect(unchangedMessage({ reply: " Tag 2 ist schon voll. " }, t, list)).toBe("noChange Tag 2 ist schon voll.");
    expect(unchangedMessage({}, t, list)).toBe("noChange");
  });
  it("ignores unknown codes and caps the names at three", () => {
    expect(readNotice({ code: "other", places: [] })).toBeNull();
    expect(readNotice({ code: "stops_not_found", places: ["a", "b", "c", "d"] })?.places).toHaveLength(3);
  });
  it("has a message in both locales for every code", () => {
    for (const code of ITERATE_NOTICES) {
      const key = NOTICE_KEY[code];
      expect((de.plan.iterate as unknown as Record<string, string>)[key]).toBeTruthy();
      expect((en.plan.iterate as unknown as Record<string, string>)[key]).toBeTruthy();
    }
  });
});

describe("driveStopNames", () => {
  it("lists distinct stop names only", () => {
    expect(driveStopNames([{ drive: { from: "Wien" } }, { drive: {} }, { drive: { from: "Wien" } }, {}, { drive: { from: "Melk" } }])).toEqual(["Wien", "Melk"]);
    expect(driveStopNames([{ drive: {} }])).toEqual([]);
  });
});
