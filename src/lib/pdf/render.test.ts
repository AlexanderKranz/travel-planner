import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { PlanDocument } from "@/lib/domain/share";
import cruise from "@/lib/server/__fixtures__/plan-document-cruise.json";
import golf from "@/lib/server/__fixtures__/plan-document-golf.json";
import de from "../../../messages/de.json";
import { makeT } from "./labels";
import { renderPlanPdf } from "./render";

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

/** Text a viewer would copy out of the PDF (via the font's ToUnicode map). */
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

const sampleFlights = (from: string, to: string) =>
  ({
    basis: "trip_dates",
    outDate: "2038-03-13",
    backDate: "2038-03-17",
    mode: { out: "schedule", back: "schedule" },
    fetchedAt: "2026-10-28T10:00:00.000Z",
    legs: [
      { dir: "out", from, to, number: "LH 1150", airline: "Lufthansa", dep: "07:50", arr: "10:40", arrDayOffset: 0, blockMin: 170, date: "2038-03-13" },
      { dir: "out", from, to, number: "DE 1504", airline: "Condor", dep: "10:50", arr: "13:40", arrDayOffset: 0, blockMin: 170, date: "2038-03-13" },
      { dir: "back", from: to, to: from, number: "LH 1151", airline: "Lufthansa", dep: "11:30", arr: "14:40", arrDayOffset: 0, blockMin: 190, date: "2038-03-17" },
    ],
  }) as unknown as PlanDocument["plan"]["flights"];

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

  it("writes the Atlas sample PDFs when PDF_SAMPLE_DIR is set", async () => {
    const dir = process.env.PDF_SAMPLE_DIR;
    if (!dir) return;
    mkdirSync(dir, { recursive: true });
    const g = structuredClone(golf) as unknown as PlanDocument;
    g.plan.flights = sampleFlights("FRA", "AGP");
    writeFileSync(path.join(dir, "atlas-golf.pdf"), await renderPlanPdf(g, makeT(de.pdf)));
    const c = structuredClone(cruise) as unknown as PlanDocument;
    c.plan.flights = sampleFlights("FRA", "VIE");
    writeFileSync(path.join(dir, "atlas-cruise.pdf"), await renderPlanPdf(c, makeT(de.pdf)));
  }, 60_000);

  it("renders place links and alternatives, no drive times (plan-3)", async () => {
    const doc = structuredClone(golf) as unknown as PlanDocument;
    const keys = Object.keys(doc.plan.places);
    expect(keys.length).toBeGreaterThan(2);
    for (const k of keys) doc.plan.places[k].drive = { min: 25, km: 21.4, source: "openrouteservice", fetchedAt: "2026-10-28T10:00:00.000Z" };
    const act = doc.plan.days[0].stops.flatMap((s) => s.acts).find((a) => a.ref)!;
    act.alts = keys.filter((k) => k !== act.ref).slice(0, 2);
    const t2 = (key: string, vars?: Record<string, string | number>) =>
      key === "alternatives" ? "oder" : t(key, vars);
    const buf = await renderPlanPdf(doc, t2);
    expect(asBuf(buf)).toBe("%PDF-");
    expect(buf.length).toBeGreaterThan(10_000);
  }, 30_000);

  it("renders without items and with the cruise fixture", async () => {
    const doc = { ...(cruise as unknown as PlanDocument), items: null, costs: null };
    const buf = await renderPlanPdf(doc, t);
    expect(asBuf(buf)).toBe("%PDF-");
  }, 30_000);
});

describe("renderPlanPdf fixed items", () => {
  it("renders booked/planned items with times in the day rows and the item list", async () => {
    const doc = structuredClone(golf) as unknown as PlanDocument;
    const base = doc.items![0];
    doc.items = [
      ...doc.items!,
      { ...base, id: "fx1", category: "flight", title: "LH 1150 FRA → AGP", status: "booked", day: 1, startTime: "07:50", endTime: "10:40" },
      { ...base, id: "fx2", category: "food", title: "Late dinner", status: "planned", day: 2, startTime: "23:30", endTime: "00:30" },
    ];
    const buf = await renderPlanPdf(doc, t);
    expect(asBuf(buf)).toBe("%PDF-");
  }, 30_000);
});

describe("renderPlanPdf text", () => {
  it("keeps umlauts, arrows, euro and fl/ff ligature letters copyable", async () => {
    const doc = structuredClone(golf) as unknown as PlanDocument;
    doc.plan.header.title = "Düsseldorf → Málaga: Pfeffer, Waffeln & Öl für 12 €";
    doc.plan.days[0].title = "Anreise → Golf, offen & Straße";
    doc.plan.flights = sampleFlights("FRA", "AGP");
    const buf = await renderPlanPdf(doc, makeT({ ...de.pdf }));
    const text = (await extractText(buf)).replace(/\s+/g, " ");
    for (const w of ["Düsseldorf → Málaga", "Pfeffer, Waffeln", "Öl für 12 €", "Anreise → Golf", "Straße", "Direktflüge", "FRA 07:50 → AGP 10:40", "Seite 1 von"]) {
      expect(text).toContain(w);
    }
    expect(text).not.toContain("’");
  }, 30_000);
});
