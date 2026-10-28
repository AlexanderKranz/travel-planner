import { describe, expect, it } from "vitest";
import { pdfFileName } from "./filename";

const h = (title: string, startDate?: string) => ({
  header: { title, destination: "X", timing: startDate ? { kind: "date", startDate } : { kind: "none" } },
});

describe("pdfFileName", () => {
  it("slugs with date", () => expect(pdfFileName(h("Costa del Sol", "2027-03-13"))).toBe("costa-del-sol-2027-03-13.pdf"));
  it("transliterates umlauts", () => expect(pdfFileName(h("Große Fähre → Wien"))).toBe("grosse-faehre-wien.pdf"));
  it("falls back", () => expect(pdfFileName(h("???"))).toBe("trip.pdf"));
});
