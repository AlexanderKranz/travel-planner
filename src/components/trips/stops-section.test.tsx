import { NextIntlClientProvider } from "next-intl";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

vi.mock("@/lib/server/itinerary", () => ({
  extractItinerary: vi.fn(async () => ({ ok: false, error: "failed" })),
  derivedTripStops: vi.fn(async () => []),
}));

import { StopRowEditor } from "./stop-row-editor";
import { StopsSection } from "./stops-section";
import { emptyRow } from "./stops-draft";
import { StopsToggle } from "./stops-toggle";

const wrap = (locale: "de" | "en", node: React.ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "de" ? de : en}>
      {node}
    </NextIntlClientProvider>,
  );

const base = {
  rows: [{ ...emptyRow(2), place: "Wien", arr: "14:00", dep: "23:59" }],
  lengthDays: 5,
  startDate: "2037-12-19",
  notes: "",
  savedNotes: "",
  tripId: null,
  canEdit: true,
  showProblems: false,
  onChange: () => undefined,
};

describe("stops section", () => {
  it("renders nothing but the wrapper while the box is unticked", () => {
    const html = wrap("de", <StopsSection {...base} multiStop={false} />);
    expect(html).not.toContain("Dokument wählen");
  });

  it("shows upload, the row with a computed date and the add button (de)", () => {
    const html = wrap("de", <StopsSection {...base} multiStop />);
    expect(html).toContain("Dokument wählen");
    expect(html).toContain("Stopp hinzufügen");
    expect(html).toContain("Tag 2 (");
    expect(html).toContain('value="Wien"');
    expect(html).toContain('accept="application/pdf,image/jpeg,image/png,image/webp"');
  });

  it("is read-only for a read grantee (no inputs, no upload)", () => {
    const html = wrap("en", <StopsSection {...base} canEdit={false} multiStop />);
    expect(html).toContain("Read-only access");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Choose document");
    expect(html).toContain("Wien");
  });

  it("warns about a stop beyond the trip and about a missing date, with labelled inputs", () => {
    const row = { ...emptyRow(7), place: "Linz", date: "2037-12-25" };
    const html = wrap("en", <StopRowEditor row={row} index={0} startDate={null} lengthDays={5} showProblems={false} onChange={() => undefined} onRemove={() => undefined} />);
    expect(html).toContain("Outside the trip dates");
    expect(html).toContain("The trip has no date yet");
    expect(html.match(/<label/g)?.length).toBeGreaterThanOrEqual(5);
    // stacked card on mobile, grid row from sm
    expect(html).toContain("sm:grid-cols-");
  });

  it("toggle has a label in both locales", () => {
    const props = { checked: false, hasStops: false, onChange: () => undefined, onClear: () => undefined };
    expect(wrap("de", <StopsToggle {...props} />)).toContain("Mehrere Stationen (Kreuzfahrt oder Rundreise)");
    expect(wrap("en", <StopsToggle {...props} />)).toContain("Several stops (cruise or round trip)");
  });
});
