import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import type { PlanDocument } from "@/lib/domain/share";
import { registerFonts } from "./fonts";
import { makeFormat } from "./format";
import { loadPdfT, type PdfT } from "./labels";
import { PlanPdf } from "./plan-pdf";

// Noto Sans has no arrows or approx sign; map them to glyphs it has.
const GLYPHS: [RegExp, string][] = [
  [/\s*[→➜➔]\s*/g, " – "],
  [/≈/g, "~"],
  [/[★☆]/g, "*"],
];
export function cleanGlyphs<T>(v: T): T {
  if (typeof v === "string") return GLYPHS.reduce((acc, [re, to]) => acc.replace(re, to), v as string) as T;
  if (Array.isArray(v)) return v.map(cleanGlyphs) as T;
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, cleanGlyphs(x)])) as T;
  }
  return v;
}

/** Labels follow plan.locale (same language as the prose). `t` override is for tests. */
export async function renderPlanPdf(doc: PlanDocument, t?: PdfT): Promise<Buffer> {
  registerFonts();
  const locale = doc.plan.locale;
  const element = createElement(PlanPdf, { doc: cleanGlyphs(doc), t: t ?? loadPdfT(locale), fmt: makeFormat(locale) });
  // renderToBuffer expects a <Document> element type; PlanPdf returns one.
  return renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
}
