import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@/lib/domain/share";
import cruise from "@/lib/server/__fixtures__/plan-document-cruise.json";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { tourBlocks } from "@/lib/plan/tour-blocks";
import { linkedTour, wienInput } from "@/lib/plan/tour-test-helpers";
import { makeFormat } from "./format";
import { makeT } from "./labels";
import { renderPlanPdf } from "./render";
import { tourLine } from "./tour-block";

async function extractText(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(content.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return pages.join("\n");
}

const stopInfo = {
  v: 1 as const,
  locale: "de" as const,
  stops: [
    { key: "osm:w2", status: "ok" as const, checkedAt: "2026-11-10T00:00:00Z", lang: "de" as const, title: "Hofburg", text: "Die Hofburg ist eine Residenz in Wien. Mehr dazu." },
  ],
};

describe("PDF city tour block (city-tour 10)", () => {
  it("line: time range, places, distance and mode from the pdf labels (de, en)", () => {
    const [b] = tourBlocks([linkedTour()], 5);
    expect(tourLine(b!, makeT(de.pdf), makeFormat("de"))).toBe("10:00–12:10 · 3 Orte · 1,6 km zu Fuß");
    expect(tourLine(b!, makeT(en.pdf), makeFormat("en"))).toBe("10:00–12:10 · 3 places · 1.6 km on foot");
    const [untimed] = tourBlocks([linkedTour({ input: wienInput(), result: null })], 5);
    expect(tourLine(untimed!, makeT(de.pdf), makeFormat("de"))).toBe("3 Orte");
  });

  it("renders the block with stops, sketch and the routes source, without items in the link", async () => {
    const doc = { ...(structuredClone(cruise) as unknown as PlanDocument), items: null, costs: null };
    doc.tours = tourBlocks([linkedTour({ tripDay: 2 }), linkedTour({ id: "u", tripDay: 3, input: wienInput() })], doc.plan.days.length);
    const buf = await renderPlanPdf(doc, makeT(de.pdf));
    const text = (await extractText(buf)).replace(/\s+/g, " ");
    expect(text.replace(/ /g, "")).toContain("STADTTOUR"); // letter-spaced label
    expect(text).toContain("10:00–12:10 · 3 Orte · 1,6 km zu Fuß");
    expect(text).toContain("1. Hofburg");
    expect(text).toContain("Routen: © openrouteservice.org");
  }, 30_000);


  it("with the opt-in Ortsinfos aufnehmen: one line per stop and the article attribution; without it the PDF is unchanged", async () => {
    const base = { ...(structuredClone(cruise) as unknown as PlanDocument), items: null, costs: null };
    const withInfo = { ...base, tours: tourBlocks([linkedTour({ tripDay: 2, stopInfo })], base.plan.days.length) };
    const text = (await extractText(await renderPlanPdf(withInfo, makeT(de.pdf)))).replace(/\s+/g, " ");
    expect(text).toContain("Die Hofburg ist eine Residenz in Wien.");
    expect(text).not.toContain("Mehr dazu");
    expect(text).toContain("Ortsinfos: Wikipedia-Artikel");
    expect(text).toContain("CC BY-SA 4.0");
    const plain = { ...base, tours: tourBlocks([linkedTour({ tripDay: 2 })], base.plan.days.length) };
    const plainText = (await extractText(await renderPlanPdf(plain, makeT(de.pdf)))).replace(/\s+/g, " ");
    expect(plainText).not.toContain("Ortsinfos");
  }, 30_000);
});

describe("PDF of a standalone city tour (city-tour 9.3)", () => {
  it("renders title, line, stops, sources; stop info only when given", async () => {
    const { renderToBuffer } = await import("@react-pdf/renderer");
    const { createElement } = await import("react");
    const { registerFonts } = await import("./fonts");
    const { TourPdf } = await import("./tour-pdf");
    const { noDayBlockOf } = await import("@/lib/plan/tour-blocks");
    registerFonts();
    const render = async (info: typeof stopInfo | null) => {
      const block = noDayBlockOf(linkedTour({ tripDay: null, stopInfo: info }));
      const el = createElement(TourPdf, { block, title: "Wien", date: null, stopTimes: null, generatedAt: "2026-11-14T00:00:00Z", locale: "de", t: makeT(de.pdf), fmt: makeFormat("de") });
      return (await extractText(await renderToBuffer(el as Parameters<typeof renderToBuffer>[0]))).replace(/\s+/g, " ");
    };
    const text = await render(null);
    expect(text).toContain("Wien");
    expect(text).toContain("3 Orte");
    expect(text).toContain("Hofburg");
    expect(text).toContain("Routen: © openrouteservice.org");
    expect(text).not.toContain("Ortsinfos");
    expect(await render(stopInfo)).toContain("Die Hofburg ist eine Residenz in Wien.");
  }, 30_000);
});
