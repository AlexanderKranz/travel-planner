import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { PlanDocument } from "@/lib/domain/share";
import cruise from "@/lib/server/__fixtures__/plan-document-cruise.json";
import de from "../../../messages/de.json";
import en from "../../../messages/en.json";
import { makeT } from "./labels";
import { renderPlanPdf } from "./render";
import { planTimeDifference } from "@/lib/facts/plan-time-difference";

vi.mock("server-only", () => ({}));

const LONG = "Frankfurt am Main, Hessen, Deutschland";

async function text(buf: Buffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const pdf = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const c = await (await pdf.getPage(i)).getTextContent();
    out.push(c.items.map((it) => ("str" in it ? it.str : "")).join(" "));
  }
  return out.join("\n");
}

function bangkokDoc(home: { name: string | null; timezone: string | null } | null): PlanDocument {
  const doc = structuredClone(cruise) as unknown as PlanDocument;
  doc.plan.facts.daylight = { ...(doc.plan.facts.daylight as object), timezone: "Asia/Bangkok" } as never;
  doc.timeDifference = planTimeDifference(doc.plan, home, "2026-10-31");
  return doc;
}

describe("PDF with a real non-zero time difference", () => {
  for (const [loc, msgs, expected] of [
    ["de", de, /\+6 Std\.\s*gegenüber Frankfurt am Main, Hessen,\s*Deutschland/],
    ["en", en, /\+6 h\s*vs\. Frankfurt am Main, Hessen,\s*Deutschland/],
  ] as const) {
    it(`renders ${loc}`, async () => {
      const doc = bangkokDoc({ name: LONG, timezone: "Europe/Berlin" });
      expect(doc.timeDifference).toMatchObject({ kind: "ahead", hours: "6" });
      const buf = await renderPlanPdf(doc, makeT(msgs.pdf));
      const txt = (await text(buf)).replace(/\s+/g, " ");
      expect(txt).toMatch(expected);
      const dir = process.env.PDF_SAMPLE_DIR;
      if (dir) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, `td-${loc}.pdf`), buf);
      }
    }, 60_000);
  }

  it("renders behind, half hour and range with minus sign", async () => {
    const doc = bangkokDoc({ name: "Los Angeles", timezone: "America/Los_Angeles" });
    expect(doc.timeDifference?.kind).toBe("ahead");
    const d2 = bangkokDoc({ name: "Kolkata", timezone: "Asia/Kolkata" });
    expect(d2.timeDifference).toMatchObject({ kind: "ahead", hours: "1:30" });
    const d3 = bangkokDoc({ name: "Tokyo", timezone: "Asia/Tokyo" });
    expect(d3.timeDifference).toMatchObject({ kind: "behind", hours: "2" });
    const buf = await renderPlanPdf(d3, makeT(de.pdf));
    expect((await text(buf)).replace(/\s+/g, " ")).toMatch(/–\s*2 Std\.\s*gegenüber Tokyo/);
  }, 60_000);

  it("keeps the sign on every render of a warm process", async () => {
    const doc = bangkokDoc({ name: "Tokyo", timezone: "Asia/Tokyo" });
    for (let i = 0; i < 3; i++) {
      const txt = (await text(await renderPlanPdf(doc, makeT(de.pdf)))).replace(/\s+/g, " ");
      expect(txt).toMatch(/–\s*2 Std\.\s*gegenüber Tokyo/);
    }
  }, 60_000);

  it("renders a negative range (daylight saving differs) with the minus sign in both locales", async () => {
    const doc = structuredClone(cruise) as unknown as PlanDocument;
    doc.plan.facts.daylight = { ...(doc.plan.facts.daylight as object), timezone: "America/New_York" } as never;
    doc.plan.header.timing = { kind: "date", startDate: "2038-03-24", endDate: "2038-03-30" } as never;
    doc.plan.header.lengthDays = 7;
    doc.timeDifference = planTimeDifference(doc.plan, null, "2026-10-31");
    expect(doc.timeDifference).toMatchObject({ kind: "range", hours: "−6", to: "−5", home: null, notes: ["changes"] });
    for (const [loc, msgs] of [["de", de], ["en", en]] as const) {
      const buf = await renderPlanPdf(doc, makeT(msgs.pdf));
      const txt = (await text(buf)).replace(/\s+/g, " ");
      expect(txt).toMatch(loc === "de" ? /–\s*6 bis\s+–\s*5 Std\.\s*gegenüber Deutschland/ : /–\s*6 to\s+–\s*5 h\s*vs\. Germany/);
      const dir = process.env.PDF_SAMPLE_DIR;
      if (dir) writeFileSync(path.join(dir, `range-${loc}.pdf`), buf);
    }
  }, 60_000);
});
