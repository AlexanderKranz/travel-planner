import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/server/stop-info/actions", () => ({ getTourStopInfo: vi.fn(), getSharedTourStopInfo: vi.fn() }));
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import type { PlanDay } from "@/lib/domain/plan";
import { tourBlocks } from "@/lib/plan/tour-blocks";
import { linkedTour, wienInput, wienResult } from "@/lib/plan/tour-test-helpers";
import { DayCard } from "@/components/plan/day-card";
import { TripToursNoDay } from "./trip-tours-no-day";
import { getSharedTourStopInfo, getTourStopInfo } from "@/lib/server/stop-info/actions";
import { StopInfoProvider } from "./stop-info/context";

vi.mock("@/i18n/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  Link: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
vi.mock("@/lib/server/plans", () => ({ editPlan: vi.fn() }));

const day: PlanDay = {
  n: 2,
  date: null,
  title: "Wien",
  stops: [
    {
      place: "Wien",
      acts: [
        { at: "09:00", kind: "food", text: "Frühstück" },
        { at: "14:00", kind: "see", text: "Prater" },
      ],
    },
  ],
};

const render = (
  props: Partial<Parameters<typeof DayCard>[0]>,
  locale: "de" | "en" = "de",
) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en} timeZone="Europe/Berlin">
      <DayCard day={day} places={{}} {...props} />
    </NextIntlClientProvider>,
  );

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

describe("tour block in the day card (city-tour 10)", () => {
  it("shows the summary line, stops in visiting order, the sketch and the link for the owner", () => {
    const html = render({ tours: tourBlocks([linkedTour()], 5), tourAccess: "owner" });
    expect(text(html)).toContain("Stadttour · 10:00–12:10 · 3 Orte · 1,6 km zu Fuß");
    expect(text(html)).toMatch(/Hofburg.*Stephansdom.*Naschmarkt/);
    expect(html).toContain("data-route-sketch");
    expect(html).toContain('href="/app/tours/00000000-0000-4000-8000-000000000001"');
    expect(html).toContain("Tour öffnen");
    expect(html).toContain("openrouteservice.org");
  });

  it("places a timed tour by the fixed-item merge rule: after 09:00, before 14:00", () => {
    const t = text(render({ tours: tourBlocks([linkedTour()], 5) }));
    expect(t.indexOf("Frühstück")).toBeLessThan(t.indexOf("Stadttour"));
    expect(t.indexOf("Stadttour")).toBeLessThan(t.indexOf("Prater"));
  });

  it("puts an untimed tour at the top with the start-time hint (owner only)", () => {
    const untimed = tourBlocks([linkedTour({ input: wienInput() })], 5);
    const owner = text(render({ tours: untimed, tourAccess: "owner" }));
    expect(owner.indexOf("Stadttour")).toBeLessThan(owner.indexOf("Frühstück"));
    expect(owner).toContain("Startzeit setzen, damit der Plan diese Zeit freihält.");
    expect(owner).toContain("Stadttour · 3 Orte");
    const reader = text(render({ tours: untimed, tourAccess: "read" }));
    expect(reader).not.toContain("Startzeit setzen");
    expect(reader).toContain("Tour öffnen");
  });

  it("lists several tours of a day in start order", () => {
    const tours = tourBlocks(
      [
        linkedTour({ id: "b", input: wienInput({ startTime: "15:00" }) }),
        linkedTour({ id: "a", input: wienInput({ startTime: "10:00" }) }),
      ],
      5,
    );
    const html = render({ tours });
    expect(html.indexOf('data-tour-block="a"')).toBeLessThan(html.indexOf('data-tour-block="b"'));
  });

  it("public share view: no link, no hint, no day action", () => {
    const html = render({ tours: tourBlocks([linkedTour({ input: wienInput() })], 5) });
    expect(html).not.toContain("/app/tours/");
    expect(html).not.toContain("Startzeit setzen");
    expect(html).not.toContain("data-day-tour-action");
  });

  it("the owner's day action links to a new tour for this day", () => {
    const html = render({ tourAction: { tripId: "T1" } });
    expect(html).toContain('href="/app/tours/new?trip=T1&amp;day=2"');
    expect(text(html)).toContain("Stadttour für diesen Tag");
  });

  it("without a result: no time range end, no distance; en strings resolve", () => {
    const html = render({ tours: tourBlocks([linkedTour({ result: null })], 5), tourAccess: "owner" }, "en");
    expect(text(html)).toContain("City tour · 10:00 · 3 places");
    expect(html).not.toContain("data-route-sketch");
    expect(text(html)).toContain("Open tour");
  });

  it("a tour of another day stays out of this card", () => {
    const html = render({ tours: tourBlocks([linkedTour({ tripDay: 3 })], 5) });
    expect(html).not.toContain("data-tour-block");
  });

  it("km in the summary follows the leg distances", () => {
    const html = render({ tours: tourBlocks([linkedTour({ result: wienResult({ legs: [] }) })], 5) });
    expect(text(html)).not.toContain(" km ");
  });
});

describe("tours without a day (trip page)", () => {
  const renderNoDay = (tours: Parameters<typeof TripToursNoDay>[0]["tours"]) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="de" messages={de} timeZone="Europe/Berlin">
        <TripToursNoDay tours={tours} lengthDays={5} />
      </NextIntlClientProvider>,
    );
  it("lists unlinked-day and beyond-length tours under 'Ohne Tag', nothing otherwise", () => {
    const html = renderNoDay([linkedTour({ id: "x", tripDay: null }), linkedTour({ id: "y", tripDay: 9 }), linkedTour({ id: "z" })]);
    expect(text(html)).toContain("Stadttouren ohne Tag");
    expect(html).toContain('href="/app/tours/x"');
    expect(html).toContain('href="/app/tours/y"');
    expect(html).not.toContain('href="/app/tours/z"');
    expect(renderNoDay([linkedTour()])).toBe("");
  });
});

describe("stop info toggles in the tour block (city-tour-stop-info 6)", () => {
  const shared = (tours = tourBlocks([linkedTour()], 5)) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale="de" messages={de} timeZone="Europe/Berlin">
        <StopInfoProvider source={{ kind: "share", token: "a".repeat(43) }}>
          <DayCard day={day} places={{}} tours={tours} />
        </StopInfoProvider>
      </NextIntlClientProvider>,
    );

  it("one collapsed toggle per OSM stop, nothing fetched on render, no read-out bar before a card is open", () => {
    const html = shared();
    expect(html.match(/Infos zum Ort/g)).toHaveLength(3);
    expect(html.match(/aria-expanded="false"/g)?.length).toBeGreaterThanOrEqual(3);
    expect(html).not.toContain("aria-expanded=\"true\"");
    expect(html).not.toContain("Tour vorlesen");
    expect(getSharedTourStopInfo).not.toHaveBeenCalled();
    expect(getTourStopInfo).not.toHaveBeenCalled();
  });

  it("without a provider (or for blocks stored before stopKeys) no toggles", () => {
    expect(render({ tours: tourBlocks([linkedTour()], 5) })).not.toContain("Infos zum Ort");
    const old = tourBlocks([linkedTour()], 5).map((b) => ({ ...b, stopKeys: undefined }));
    expect(shared(old)).not.toContain("Infos zum Ort");
  });
});
