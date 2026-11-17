import { describe, expect, it } from "vitest";
import { isServerActionRequest, protectedAreaLocale } from "./protected-paths";

describe("protectedAreaLocale", () => {
  it("flags app and settings areas", () => {
    expect(protectedAreaLocale("/de/app")).toBe("de");
    expect(protectedAreaLocale("/en/app/groups/1")).toBe("en");
    expect(protectedAreaLocale("/en/settings")).toBe("en");
  });
  it("leaves public pages alone", () => {
    expect(protectedAreaLocale("/de")).toBeNull();
    expect(protectedAreaLocale("/de/login")).toBeNull();
    expect(protectedAreaLocale("/de/application")).toBeNull();
    expect(protectedAreaLocale("/fr/app")).toBeNull();
    expect(protectedAreaLocale("/app")).toBeNull();
  });
});

describe("isServerActionRequest", () => {
  it("detects the Next-Action header in any case", () => {
    expect(isServerActionRequest(new Headers({ "Next-Action": "abc" }))).toBe(true);
    expect(isServerActionRequest(new Headers({ "next-action": "abc" }))).toBe(true);
  });
  it("leaves page requests alone", () => {
    expect(isServerActionRequest(new Headers({ accept: "text/html" }))).toBe(false);
  });
});
