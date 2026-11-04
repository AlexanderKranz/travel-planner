import { describe, expect, it, vi } from "vitest";
import { purposeTagsHash } from "@/lib/plan/hash";
import { oneOffLabel, oneOffPurpose, oneOffTagsHash } from "./one-off";

vi.mock("server-only", () => ({}));

describe("oneOffLabel", () => {
  it("short text stays, whitespace is collapsed", () => {
    expect(oneOffLabel("Golf mit einem Freund")).toBe("Golf mit einem Freund");
    expect(oneOffLabel("  Golf \n\n mit\teinem   Freund ")).toBe("Golf mit einem Freund");
  });
  it("exactly 60 characters is not cut", () => {
    const t = "a".repeat(60);
    expect(oneOffLabel(t)).toBe(t);
  });
  it("a longer text is cut at a word boundary with an ellipsis, at most 60 characters", () => {
    const l = oneOffLabel("Golf mit einem Freund, flache Plätze, gutes Essen, höchstens 3 Stunden Flug ab Frankfurt");
    expect(l.endsWith("…")).toBe(true);
    expect(l.length).toBeLessThanOrEqual(60);
    expect(l).toBe("Golf mit einem Freund, flache Plätze, gutes Essen…");
  });
  it("a text without spaces is cut hard", () => {
    expect(oneOffLabel("x".repeat(100))).toBe(`${"x".repeat(59)}…`);
  });
  it("does not split an emoji", () => {
    const l = oneOffLabel("🏌️".repeat(40));
    expect(l.endsWith("…")).toBe(true);
    expect(() => encodeURIComponent(l)).not.toThrow();
  });
});

describe("oneOffPurpose", () => {
  it("a transient purpose: empty id and timestamps, the text, no guided fields or constraints", () => {
    const p = oneOffPurpose("  Golf mit einem Freund ", null);
    expect(p).toEqual({ id: "", name: "Golf mit einem Freund", text: "Golf mit einem Freund", guided: {}, constraints: [], tags: null, createdAt: "", updatedAt: "" });
  });
  it("carries the tags", () => {
    const tags = { v: 1 as const, interests: ["golf" as const], custom: [], hard: [], soft: [], summary: "s" };
    expect(oneOffPurpose("Golf", tags).tags).toBe(tags);
  });
});

describe("oneOffTagsHash", () => {
  const saved = (o: { text?: string; constraints?: string[]; guided?: { interests: string[] } } = {}) => ({ text: "Golf mit einem Freund", constraints: [], guided: {}, ...o });
  it("equals purposeTagsHash of a saved purpose with the same text and nothing else", () => {
    expect(oneOffTagsHash("Golf mit einem Freund")).toBe(purposeTagsHash(saved()));
    expect(oneOffTagsHash("  Golf mit einem Freund  ")).toBe(purposeTagsHash(saved()));
  });
  it("differs with a constraint, a custom interest or another text", () => {
    const h = oneOffTagsHash("Golf mit einem Freund");
    expect(purposeTagsHash(saved({ constraints: ["single rooms"] }))).not.toBe(h);
    expect(purposeTagsHash(saved({ guided: { interests: ["Whisky"] } }))).not.toBe(h);
    expect(oneOffTagsHash("Golf mit zwei Freunden")).not.toBe(h);
  });
  it("is sha256 hex (the DB check)", () => {
    expect(oneOffTagsHash("Golf")).toMatch(/^[0-9a-f]{64}$/);
  });
});
