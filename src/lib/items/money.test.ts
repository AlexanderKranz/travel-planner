import { describe, expect, it } from "vitest";
import { parseMoney } from "./money";

describe("parseMoney", () => {
  it.each([
    ["432,64", "de", 43264],
    ["432.64", "de", 43264],
    ["1.234,56", "de", 123456],
    ["1.234", "de", 123400],
    ["1,234.56", "en", 123456],
    ["1,234", "en", 123400],
    ["432.64", "en", 43264],
    ["459", "en", 45900],
    ["459,5", "de", 45950],
    ["€ 1 234,56", "de", 123456],
    ["$1,234.56", "en", 123456],
    ["1.234.567,89", "de", 123456789 > 100000000 ? "invalid" : 123456789],
    ["0", "en", 0],
  ])("%s (%s)", (input, locale, expected) => {
    expect(parseMoney(input, locale)).toBe(expected);
  });
  it("empty gives null", () => {
    expect(parseMoney("", "de")).toBeNull();
    expect(parseMoney("   ", "en")).toBeNull();
  });
  it.each(["abc", "-5", "1,234", "12.345.6", "1,2,3", "1.234,567", ",5", "99999999999"])("invalid %s", (input) => {
    expect(parseMoney(input, input === "1,234" ? "de" : "en")).toBe("invalid");
  });
});
