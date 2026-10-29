import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import type { PlanFlights as PlanFlightsData } from "@/lib/domain/plan";
import { flightGroups, PlanFlights } from "./plan-flights";

const leg = (o: Partial<PlanFlightsData["legs"][number]>): PlanFlightsData["legs"][number] => ({
  dir: "out", from: "FRA", to: "CPH", number: "LH 826", airline: "Lufthansa", dep: "07:50", arr: "09:15", arrDayOffset: 0, blockMin: 85, date: "2038-07-10", ...o,
});
const flights: PlanFlightsData = {
  basis: "trip_dates", outDate: "2038-07-10", backDate: "2038-07-17", mode: { out: "schedule", back: "schedule" },
  pairs: [{ from: "FRA", to: "CPH", status: "found" }],
  legs: [
    leg({ number: "LH 828", dep: "12:10", arr: "13:35" }),
    leg({}),
    leg({ dir: "back", from: "CPH", to: "FRA", number: "LH 829", dep: "14:25", arr: "15:55", date: "2038-07-17" }),
  ],
  maxBlockMin: null, source: "aerodatabox", fetchedAt: "2026-10-28T00:00:00.000Z",
};

describe("PlanFlights", () => {
  it("groups by direction and route, sorted by departure", () => {
    expect(flightGroups(flights.legs).map((g) => `${g.dir} ${g.from}-${g.to} ${g.legs.map((l) => l.dep).join(",")}`)).toEqual([
      "out FRA-CPH 07:50,12:10",
      "back CPH-FRA 14:25",
    ]);
  });
  it("one heading per direction, one grid row per flight with the action slot", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="de" messages={de} timeZone="Europe/Berlin">
        <PlanFlights flights={flights} renderAction={(l) => <button type="button">act {l.number}</button>} />
      </NextIntlClientProvider>,
    );
    expect(html.match(/Hinflug · /g)).toHaveLength(1);
    expect(html.match(/Rückflug · /g)).toHaveLength(1);
    expect(html).toMatch(/Hinflug · Sa\.?,? 10\. Juli · FRA → CPH/);
    expect(html).toContain("07:50 – 09:15");
    expect(html).toContain("1 h 25");
    expect(html.match(/<li class="col-span-full grid grid-cols-subgrid/g)).toHaveLength(3);
    expect(html.match(/act LH 8\d\d/g)).toHaveLength(3);
  });
});
