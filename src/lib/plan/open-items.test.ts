import { describe, expect, it } from "vitest";
import { openItemKey } from "./open-items";

describe("openItemKey", () => {
  it("is 8 hex chars and stable", () => {
    expect(openItemKey("Book the ferry")).toMatch(/^[0-9a-f]{8}$/);
    expect(openItemKey("Book the ferry")).toBe(openItemKey("Book the ferry"));
  });
  it("ignores case and surrounding space, differs for other text", () => {
    expect(openItemKey("  Book The Ferry ")).toBe(openItemKey("book the ferry"));
    expect(openItemKey("Book the train")).not.toBe(openItemKey("Book the ferry"));
  });
  it("matches the FNV-1a reference for the empty string and 'a'", () => {
    expect(openItemKey("")).toBe("811c9dc5");
    expect(openItemKey("a")).toBe("e40c292c");
  });
});
