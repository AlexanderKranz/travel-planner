import { describe, expect, it } from "vitest";
import { flightLinks } from "./links";

describe("flightLinks", () => {
  const a = { from: "FRA", to: "AGP", out: "2027-03-13", back: "2027-03-17", adults: 2, locale: "de" as const };
  it("exact URLs (de)", () => {
    expect(flightLinks({ ...a, airlineIata: "LH" })).toEqual({
      google:
        "https://www.google.com/travel/flights?hl=de&q=Flights%20from%20FRA%20to%20AGP%20on%202027-03-13%20through%202027-03-17%20nonstop",
      skyscanner:
        "https://www.skyscanner.de/transport/flights/fra/agp/270313/270317/?adultsv2=2&stops=!oneStop,!twoPlusStops",
      airline: "https://www.lufthansa.com",
    });
  });
  it("en uses skyscanner.net, min 1 adult, no airline link for unknown carriers", () => {
    const l = flightLinks({ ...a, locale: "en", adults: 0, airlineIata: "ZZ" });
    expect(l.skyscanner).toBe("https://www.skyscanner.net/transport/flights/fra/agp/270313/270317/?adultsv2=1&stops=!oneStop,!twoPlusStops");
    expect(l.google).toContain("hl=en");
    expect(l.airline).toBeUndefined();
  });
});
