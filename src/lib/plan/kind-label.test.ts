import { describe, expect, it } from "vitest";
import { kindLabelKey } from "./kind-label";

describe("kindLabelKey", () => {
  it("labels travel by day position", () => {
    expect(kindLabelKey("travel", 0, 5)).toBe("travelArrival");
    expect(kindLabelKey("travel", 2, 5)).toBe("travel");
    expect(kindLabelKey("travel", 4, 5)).toBe("travelDeparture");
  });
  it("keeps plain travel for one-day trips and unknown counts", () => {
    expect(kindLabelKey("travel", 0, 1)).toBe("travel");
    expect(kindLabelKey("travel", 0)).toBe("travel");
  });
  it("leaves other kinds alone", () => {
    expect(kindLabelKey("food", 0, 5)).toBe("food");
    expect(kindLabelKey("see", 4, 5)).toBe("see");
  });
});
