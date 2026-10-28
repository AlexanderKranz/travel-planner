import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import type { Plan, PlanDay } from "@/lib/domain/plan";
import { DayCard } from "./day-card";

const place = (name: string, extra: Partial<Plan["places"][string]> = {}): Plan["places"][string] => ({
  name, category: "leisure=golf_course", lat: 36.5, lon: -4.9, distanceKm: 8.2, osmUrl: "https://www.openstreetmap.org/way/1",
  source: "osm", fetchedAt: "2026-10-28T00:00:00.000Z", ...extra,
});
const places: Plan["places"] = {
  "way/1": place("Real Club de Golf Las Brisas", { website: "https://lasbrisas.example", drive: { min: 14, km: 11.2, source: "openrouteservice", fetchedAt: "2026-10-28T00:00:00.000Z" } }),
  "way/2": place("Los Naranjos Golf Club", { wikipedia: "es:Los Naranjos Golf Club" }),
  "way/3": place("Aloha", { drive: { min: 9, km: 6, source: "openrouteservice", fetchedAt: "2026-10-28T00:00:00.000Z" } }),
};
const day: PlanDay = {
  n: 1, date: "2038-03-13", title: "Marbella",
  stops: [{ place: "Marbella", acts: [
    { at: "09:00", kind: "sport", text: "18 Löcher, moderates Gelände", ref: "way/1", alts: ["way/2", "way/3"] },
    { at: "13:00", kind: "food", text: "Mittagessen" },
  ] }],
};

const render = (locale: "de" | "en", messages: object, d = day) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Berlin">
      <DayCard day={d} places={places} />
    </NextIntlClientProvider>,
  );

describe("DayCard places", () => {
  it("leads with the linked place name, then text, drive time and alternatives (de)", () => {
    const html = render("de", de);
    const name = html.indexOf("Real Club de Golf Las Brisas");
    expect(name).toBeGreaterThan(-1);
    expect(name).toBeLessThan(html.indexOf("18 Löcher"));
    expect(html).toContain('href="https://lasbrisas.example/"');
    expect(html).toContain("🚗 14 Min.");
    expect(html).toContain("oder:");
    expect(html).toContain('href="https://es.wikipedia.org/wiki/Los_Naranjos_Golf_Club"');
    expect(html).toContain("🚗 9 Min.");
    expect(html).toContain("openrouteservice.org");
  });

  it("en strings resolve; an old plan without alts/drive shows straight-line km", () => {
    const html = render("en", en);
    expect(html).toContain("🚗 14 min");
    expect(html).toContain("or:");
    const old: PlanDay = { ...day, stops: [{ place: "Marbella", acts: [{ kind: "sport", text: "Runde", ref: "way/2" }] }] };
    const oldHtml = render("en", en, old);
    expect(oldHtml).toContain("8.2 km straight-line");
    expect(oldHtml).not.toContain("🚗");
    expect(oldHtml).not.toContain("openrouteservice");
  });
});
