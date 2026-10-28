import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import type { PlanDocument } from "@/lib/domain/share";
import { registerFonts } from "./fonts";
import { makeFormat } from "./format";
import { loadPdfT, type PdfT } from "./labels";
import { PlanPdf } from "./plan-pdf";

/** Labels follow plan.locale (same language as the prose). `t` override is for tests. */
export async function renderPlanPdf(doc: PlanDocument, t?: PdfT): Promise<Buffer> {
  registerFonts();
  const locale = doc.plan.locale;
  const element = createElement(PlanPdf, { doc: doc, t: t ?? loadPdfT(locale), fmt: makeFormat(locale) });
  // renderToBuffer expects a <Document> element type; PlanPdf returns one.
  return renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
}
