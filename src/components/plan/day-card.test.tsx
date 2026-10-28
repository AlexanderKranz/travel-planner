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

describe("DayCard fixed items", () => {
  const fixed = [
    { id: "f1", day: 1, from: "07:50", to: "08:40", category: "flight" as const, title: "LH 1150 FRA → AGP", status: "booked" as const },
    { id: "f2", day: 1, from: "15:00", category: "stay" as const, title: "Check-in Hotel", status: "planned" as const },
    { id: "f3", day: 2, from: "09:00", category: "activity" as const, title: "Other day", status: "booked" as const },
  ];
  const html = (locale: "de" | "en", messages: object) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Berlin">
        <DayCard day={day} places={places} fixed={fixed} />
      </NextIntlClientProvider>,
    );
  it("renders fixed rows in time order between the activities, with status and category (de)", () => {
    const h = html("de", de);
    const order = ["LH 1150 FRA → AGP", "18 Löcher", "Mittagessen", "Check-in Hotel"].map((s) => h.indexOf(s));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(h).toContain("07:50–08:40");
    expect(h).toContain("Gebucht");
    expect(h).toContain("Geplant");
    expect(h).toContain("Unterkunft");
    expect(h).not.toContain("Other day");
  });
  it("labels them in English", () => {
    const h = html("en", en);
    expect(h).toContain("Booked");
    expect(h).toContain("Stay");
  });
});

describe("DayCard drive times and quick add", () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="de" messages={de} timeZone="Europe/Berlin">
      <DayCard day={day} places={places} renderQuickAdd={(p) => <button type="button">add {p.name}</button>} />
    </NextIntlClientProvider>,
  );
  it("drive badges and the ORS credit are hidden unless the plan scope shows drive times", () => {
    expect(html).toMatch(/class="hidden group-data-\[drive=on\]\/plan:inline[^"]*"[^>]*>🚗 14 Min\./);
    expect(html).toMatch(/class="hidden group-data-\[drive=on\]\/plan:inline">[^<]*<a href="https:\/\/openrouteservice.org\/"/);
  });
  it("the quick add sits in its own grid column, not inside the text", () => {
    expect(html).toContain('class="group/act grid min-w-0 grid-cols-[minmax(0,1fr)_2.75rem]');
    expect(html).toMatch(/<\/div><div class="-my-2\.5 flex justify-end"><button type="button">add Real Club/);
  });
});
