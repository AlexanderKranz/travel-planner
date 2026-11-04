import { describe, expect, it } from "vitest";
import { DestinationSearchInput } from "./destination-search";

const PURPOSE = "11111111-1111-4111-8111-111111111111";

describe("DestinationSearchInput: one-off purpose (spec 13.1)", () => {
  it("exactly one of purposeId and purposeText", () => {
    expect(DestinationSearchInput.safeParse({ purposeText: "Golf mit einem Freund" }).success).toBe(true);
    expect(DestinationSearchInput.safeParse({ purposeId: PURPOSE }).success).toBe(true);
    expect(DestinationSearchInput.safeParse({}).success).toBe(false);
    const both = DestinationSearchInput.safeParse({ purposeId: PURPOSE, purposeText: "Golf mit einem Freund" });
    expect(both.success).toBe(false);
    if (!both.success) expect(both.error.issues[0].path).toEqual(["purposeId"]);
  });
  it("the text is trimmed, 3 to 500 characters after the trim", () => {
    expect(DestinationSearchInput.parse({ purposeText: "  Golf  " }).purposeText).toBe("Golf");
    expect(DestinationSearchInput.safeParse({ purposeText: "ab" }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeText: "  ab  " }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeText: "abc" }).success).toBe(true);
    expect(DestinationSearchInput.safeParse({ purposeText: "a".repeat(500) }).success).toBe(true);
    expect(DestinationSearchInput.safeParse({ purposeText: "a".repeat(501) }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeText: ` ${"a".repeat(500)} ` }).success).toBe(true);
  });
  it("a whitespace-only text is not a text", () => {
    expect(DestinationSearchInput.safeParse({ purposeText: "     " }).success).toBe(false);
  });
  it("the travel-mode rules still apply to a typed purpose", () => {
    expect(DestinationSearchInput.safeParse({ purposeText: "Wandern", travelMode: "drive" }).success).toBe(false);
    expect(DestinationSearchInput.safeParse({ purposeText: "Wandern", travelMode: "drive", maxDriveHours: 3 }).success).toBe(true);
  });
});
