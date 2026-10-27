import { describe, expect, it } from "vitest";
import de from "../../messages/de.json";
import en from "../../messages/en.json";

function keys(obj: Record<string, unknown>, prefix = ""): string[] {
  return Object.entries(obj).flatMap(([k, v]) =>
    v && typeof v === "object"
      ? keys(v as Record<string, unknown>, `${prefix}${k}.`)
      : [`${prefix}${k}`],
  );
}

describe("messages", () => {
  it("de.json and en.json have identical key sets", () => {
    expect(keys(de).sort()).toEqual(keys(en).sort());
  });

  it("has no empty strings", () => {
    for (const [name, file] of [["de", de], ["en", en]] as const) {
      const empty = keys(file).filter((k) =>
        k.split(".").reduce<unknown>((o, p) => (o as Record<string, unknown>)[p], file) === "",
      );
      expect(empty, name).toEqual([]);
    }
  });
});
