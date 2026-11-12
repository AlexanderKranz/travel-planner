/**
 * Writes the synthetic itinerary documents to evals/fixtures/itinerary/ (docs/specs/itinerary-upload.md section 9).
 * Run: `npm run evals:itinerary-docs`. No network, no model call. The files are committed so the live eval and the
 * frontend can use them without rendering; rerun after changing the Danube fixture or `docLines`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { docLines, ITINERARY_DOCS, PHOTO_DOC, renderDocPdf, renderPhoto } from "./itinerary-docs";
import { ITINERARY_FIXTURE_DIR } from "./itinerary-recorded";

vi.mock("server-only", () => ({}));

describe.runIf(process.env.EVAL_DOCS === "1")("itinerary documents", () => {
  it("renders the PDFs and the photo", async () => {
    mkdirSync(ITINERARY_FIXTURE_DIR, { recursive: true });
    for (const id of ITINERARY_DOCS) {
      const pdf = await renderDocPdf(docLines(id));
      writeFileSync(join(ITINERARY_FIXTURE_DIR, `${id}.pdf`), pdf);
      if (id === "donau-table") {
        const jpg = await renderPhoto(new Uint8Array(pdf));
        expect(jpg.length).toBeLessThan(2 * 1024 * 1024);
        writeFileSync(join(ITINERARY_FIXTURE_DIR, `${PHOTO_DOC}.jpg`), jpg);
      }
    }
  });
});
