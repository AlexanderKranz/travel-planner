import { describe, expect, it } from "vitest";
import { NETWORK_ABORT_ERRORS } from "./sentry-options";

const ignored = (msg: string) => NETWORK_ABORT_ERRORS.some((re) => re.test(msg));

describe("Sentry network-abort filter", () => {
  it("drops browser messages for a cut-off fetch", () => {
    expect(ignored("Load failed")).toBe(true);
    expect(ignored("TypeError: Load failed")).toBe(true);
    expect(ignored("Failed to fetch")).toBe(true);
    expect(ignored("NetworkError when attempting to fetch resource.")).toBe(true);
  });
  it("keeps real errors that merely mention loading", () => {
    expect(ignored("Load failed for chunk 12")).toBe(false);
    expect(ignored("Cannot read properties of undefined")).toBe(false);
  });
});
