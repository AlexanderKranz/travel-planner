import { describe, expect, it } from "vitest";
import { makeT } from "./labels";

describe("makeT", () => {
  const t = makeT({ a: { b: "x {n}/{total}" }, c: "y" });
  it("interpolates and resolves nested keys", () => expect(t("a.b", { n: 1, total: 3 })).toBe("x 1/3"));
  it("returns the key when missing", () => {
    expect(t("nope")).toBe("nope");
    expect(t("a")).toBe("a");
  });
  it("keeps unknown placeholders", () => expect(t("a.b", { n: 1 })).toBe("x 1/{total}"));
});
