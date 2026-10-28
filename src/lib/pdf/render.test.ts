import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@/lib/domain/share";
import cruise from "@/lib/server/__fixtures__/plan-document-cruise.json";
import golf from "@/lib/server/__fixtures__/plan-document-golf.json";
import { makeT } from "./labels";
import { cleanGlyphs, renderPlanPdf } from "./render";

// Local label stub until the pdf.* messages land.
const t = makeT({
  aiNote: "AI-written itinerary from verified facts",
  version: "version {n}",
  days: "Tage",
  persons: "Personen",
  day: "Tag {n}",
  best: "Highlight",
  note: "Hinweis",
  warning: "Achtung",
  flights: "Flüge",
  flightsNote: "Zeiten können sich ändern · AeroDataBox, geprüft {date}",
  costs: "Kosten",
  items: "Posten",
  openItems: "Offene Punkte",
  tips: "Tipps",
  packing: "Packliste",
  sources: "Quellen: OpenStreetMap, Open-Meteo, AeroDataBox",
  generated: "erstellt {date}",
  page: "{n}/{total}",
  statuses: { option: "Option", planned: "Geplant", booked: "Gebucht", rejected: "Verworfen" },
  categories: { flight: "Flug", stay: "Unterkunft", car: "Auto", transport: "Transport", activity: "Aktivität", food: "Essen", other: "Sonstiges" },
  perPerson: "p. P.",
  total: "Gesamt",
  booked: "Gebucht",
  expected: "Erwartet",
  datesOpen: "Datum offen",
});

const asBuf = (b: Buffer) => b.subarray(0, 5).toString("latin1");

describe("cleanGlyphs", () => {
  it("maps glyphs missing in Noto Sans", () => {
    expect(cleanGlyphs({ a: ["Wachau → Wien ≈ 5"] })).toEqual({ a: ["Wachau – Wien ~ 5"] });
  });
});

describe("renderPlanPdf", () => {
  it("renders the golf fixture", async () => {
    const buf = await renderPlanPdf(golf as unknown as PlanDocument, t);
    expect(buf.length).toBeGreaterThan(10_000);
    expect(asBuf(buf)).toBe("%PDF-");
    const dir = process.env.PDF_SAMPLE_DIR;
    if (dir) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "golf.pdf"), buf);
    }
  }, 30_000);

  it("renders without items and with the cruise fixture", async () => {
    const doc = { ...(cruise as unknown as PlanDocument), items: null, costs: null };
    const buf = await renderPlanPdf(doc, t);
    expect(asBuf(buf)).toBe("%PDF-");
  }, 30_000);
});
