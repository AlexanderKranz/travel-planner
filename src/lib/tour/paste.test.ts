import { describe, expect, it } from "vitest";
import { splitPlaceList } from "./paste";

describe("splitPlaceList", () => {
  it("one name per line keeps commas; numbering and bullets go", () => {
    expect(splitPlaceList("1. Stephansdom\n2) Café Central, Wien\n- Hofburg\n• Naschmarkt; Karlskirche\n", 25)).toEqual([
      "Stephansdom",
      "Café Central, Wien",
      "Hofburg",
      "Naschmarkt",
      "Karlskirche",
    ]);
  });

  it("one line: commas or semicolons separate; short names and duplicates dropped; capped", () => {
    expect(splitPlaceList("Stephansdom, Hofburg; ab, stephansdom , Prater", 25)).toEqual(["Stephansdom", "Hofburg", "Prater"]);
    expect(splitPlaceList("Aaa, Bbb, Ccc, Ddd", 2)).toEqual(["Aaa", "Bbb"]);
    expect(splitPlaceList("   \n  ", 25)).toEqual([]);
  });
});
