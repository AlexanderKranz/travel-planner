import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TourInput, type TourResult } from "@/lib/domain/tour";
import { encodePolyline } from "@/lib/tour/polyline";
import { HOFBURG, NASCHMARKT, STEPHANSDOM, WIEN_CITY } from "@/lib/tour/fixtures.test-data";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { RouteSketch } from "./route-sketch";
import { TourResultView, type TourResultProps } from "./tour-result";

const input = TourInput.parse({ city: WIEN_CITY, places: [STEPHANSDOM, HOFBURG, NASCHMARKT], startTime: "10:00", maxMin: 100 });
const poly = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) => encodePolyline([[a.lat, a.lon], [b.lat, b.lon]]);
const result: TourResult = {
  v: 1,
  order: [STEPHANSDOM.key, HOFBURG.key, NASCHMARKT.key],
  legs: [
    { from: STEPHANSDOM.key, to: HOFBURG.key, mode: "foot", route: "fastest", min: 9, km: 0.74, poly: poly(STEPHANSDOM, HOFBURG), s: "ok" },
    { from: HOFBURG.key, to: NASCHMARKT.key, mode: "cycling", route: "quiet", min: null, km: null, poly: null, s: "no_route" },
  ],
  totalMin: null,
  fit: "none",
  sunset: "16:05",
  sights: [{ key: "osm:n77", name: "Michaelerplatz", lat: 48.208, lon: 16.367, leg: 0, m: 43, cat: "attraction" }],
  source: { ors: "2026-11-12T10:00:00Z", osm: "2026-11-10T10:00:00Z" },
};

type Messages = Record<string, unknown>;
const render = (locale: "de" | "en", messages: Messages, props: Partial<TourResultProps> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={messages} timeZone="Europe/Berlin">
      <TourResultView input={input} result={result} stopTimes={null} byMin={null} mapStyleUrl={null} {...props} />
    </NextIntlClientProvider>,
  );

const keysOf = (o: unknown, prefix = ""): string[] =>
  o && typeof o === "object"
    ? Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => keysOf(v, prefix ? `${prefix}.${k}` : k))
    : [prefix];

describe("tour messages", () => {
  it("de and en have the same tours keys, including the T5 route labels", () => {
    expect(keysOf((de as Messages).tours).sort()).toEqual(keysOf((en as Messages).tours).sort());
    const routes = (m: Messages) => (m.tours as { routes: Record<string, string> }).routes;
    expect(routes(de as Messages)).toEqual({
      fastest: "Schnellste",
      shortest: "Kürzeste",
      green: "Grüner",
      quiet: "Ruhiger",
      no_steps: "Ohne Treppen",
      no_highways: "Ohne Autobahn",
    });
    expect(routes(en as Messages)).toEqual({
      fastest: "Fastest",
      shortest: "Shortest",
      green: "Greener",
      quiet: "Quieter",
      no_steps: "No steps",
      no_highways: "No motorways",
    });
    const help = (m: Messages) => (m.tours as { routeHelp: Record<string, string> }).routeHelp;
    expect(help(de as Messages).green).toContain("OpenStreetMap-Daten der Gegend");
    expect(help(en as Messages).quiet).toContain("OpenStreetMap data of the area");
  });
});

describe("TourResultView", () => {
  it("shows stops, legs, the failed leg, sunset, nearby sights and the sources (read-only: no controls)", () => {
    const html = render("de", de as Messages);
    expect(html).toContain("Stephansdom");
    expect(html).toContain("9 Min.");
    expect(html).toContain("0,7 km");
    expect(html).toContain("Schnellste");
    expect(html).toContain("Zwischen diesen Orten gibt es mit diesem Verkehrsmittel keinen Weg.");
    expect(html).toContain("Endet nach Sonnenuntergang (16:05)");
    expect(html).toContain("Michaelerplatz");
    expect(html).toContain("40 m vom Weg (Luftlinie)");
    expect(html).toContain("© OpenStreetMap, geprüft am");
    expect(html).toContain("openrouteservice.org");
    expect(html).toContain("ohne Wartezeiten, Ampeln oder Andrang");
    expect(html).toContain("Karte nicht verfügbar");
    expect(html).toContain("https://www.google.com/maps/dir/");
    expect(html).toContain("abweichend"); // the cycling leg differs from the tour mode
    expect(html).not.toContain("Ändern");
    expect(html).not.toContain("+ hinzufügen");
  });

  it("shows owner controls, the fit badge and the outdated notice", () => {
    const html = render("en", en as Messages, {
      onChangeLeg: () => {},
      onAddSight: () => {},
      sightInTour: () => false,
      canAddMore: true,
      result: { ...result, fit: "over", totalMin: 118 },
      byMin: 18,
      stopTimes: [
        { arrive: "10:00", leave: "10:30" },
        { arrive: "10:39", leave: "11:09" },
        { arrive: "11:30", leave: "12:00" },
      ],
      proposals: [{ kind: "drop", key: HOFBURG.key, totalMin: 95 }],
      droppedOverrides: 2,
    });
    expect(html).toContain("Change");
    expect(html).toContain("+ add");
    expect(html).toContain("18 min too long");
    const stale = render("en", en as Messages, { outdated: true, result: { ...result, fit: "over", totalMin: 118 }, byMin: 18 });
    expect(stale).toContain("The tour was changed");
    expect(stale).not.toContain("too long"); // judged on another input
    expect(html).toContain("10:39–11:09");
    expect(html).toContain("Leave out Hofburg: approx. 1 h 35 min");
    expect(html).toContain("2 leg settings no longer apply");
  });
});

describe("RouteSketch", () => {
  it("draws legs (dashed for overrides) and numbered stops, labelled when asked", () => {
    const html = renderToStaticMarkup(
      <RouteSketch
        legs={[{ poly: poly(STEPHANSDOM, HOFBURG) }, { poly: poly(HOFBURG, NASCHMARKT), dashed: true }]}
        points={[{ ...STEPHANSDOM, n: 1 }, { ...HOFBURG, n: 2 }, { ...NASCHMARKT, n: 3 }]}
        label="Skizze"
      />,
    );
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Skizze"');
    expect(html.match(/<path /g)).toHaveLength(2);
    expect(html).toContain('stroke-dasharray="6 5"');
    expect(html).toContain(">3</text>");
    expect(renderToStaticMarkup(<RouteSketch legs={[]} points={[STEPHANSDOM]} />)).toContain('aria-hidden="true"');
  });
});
