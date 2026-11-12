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
});
