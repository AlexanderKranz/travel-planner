import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { createElement } from "react";
import type { TourStopInfo } from "@/lib/domain/stop-info";
import type { Tour } from "@/lib/domain/tour";
import { noDayBlockOf } from "@/lib/plan/tour-blocks";
import { logEvent } from "@/lib/server/events";
import { tourView } from "@/lib/tour/view";
import { pdfHeaders } from "./response";
import { registerFonts } from "./fonts";
import { makeFormat } from "./format";
import { loadPdfT } from "./labels";
import { TourPdf } from "./tour-pdf";

/** "Stadttour-Wien.pdf": the title reduced to safe characters. */
export function tourPdfFileName(label: string, title: string): string {
  const base = `${label}-${title}`
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return `${base || "tour"}.pdf`;
}

/** The tour's display title without the UI translator: own title, else the city, else "Stadttour · first place". */
export function tourPdfTitle(tour: Pick<Tour, "title" | "input">, label: string): string {
  return tour.title?.trim() || tour.input.city?.name || [label, tour.input.places[0]?.name].filter(Boolean).join(" · ");
}

/**
 * Renders a standalone tour PDF (city-tour 9.3) from the stored snapshot and logs `pdf.generated` (metadata only).
 * Throws on render failure. `stopInfo`: stored info for the opt-in "Ortsinfos aufnehmen", else null.
 */
export async function tourPdfResponse(
  tour: Tour,
  locale: string,
  stopInfo: TourStopInfo | null,
  via: "owner" | "share",
  userId?: string,
): Promise<Response> {
  const t0 = Date.now();
  registerFonts();
  const t = loadPdfT(locale);
  const fmt = makeFormat(locale);
  // An outdated result belongs to another input: the PDF then lists the current stops without route, times or sketch.
  const result = tour.outdated ? null : tour.result;
  const block = noDayBlockOf({ id: tour.id, tripDay: null, title: tour.title, input: tour.input, result, updatedAt: tour.updatedAt, stopInfo });
  const view = tour.outdated ? null : tourView(tour.input, tour.result);
  const title = tourPdfTitle(tour, t("tour.label"));
  const element = createElement(TourPdf, {
    block,
    title,
    date: tour.input.date ?? null,
    stopTimes: view?.stopTimes ?? null,
    generatedAt: new Date().toISOString(),
    locale,
    t,
    fmt,
  });
  const buf = await renderToBuffer(element as Parameters<typeof renderToBuffer>[0]);
  await logEvent({
    event: "pdf.generated",
    userId: userId ?? null,
    route: via === "owner" ? "/api/tours/[id]/pdf" : "/api/share/[token]/pdf",
    props: { via, kind: "tour", stops: block.stops.length, stopInfo: !!block.info, bytes: buf.length, ms: Date.now() - t0 },
  });
  return new Response(new Uint8Array(buf), { status: 200, headers: pdfHeaders(tourPdfFileName(t("tour.label"), title), buf.length) });
}
