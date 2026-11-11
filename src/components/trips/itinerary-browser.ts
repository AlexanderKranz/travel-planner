"use client";

import { MAX_ITINERARY_IMAGE_B64, type ItineraryExtractInput } from "@/lib/domain/itinerary";
import { fitSize, hasTextLayer, MAX_IMAGE_EDGE, MAX_PDF_PAGES, MAX_SCAN_PAGES, type ItinerarySource } from "./itinerary-read";

/**
 * Browser-only file reading (docs/specs/itinerary-upload.md sections 3 and 6). The file never leaves the browser:
 * only text or downscaled JPEGs are returned. Not unit tested (needs canvas and pdf.js in a real browser).
 */

type UploadImage = Extract<ItineraryExtractInput, { kind: "images" }>["images"][number];
export type ReadResult = { source: ItinerarySource; pages: number; truncatedTo?: number };

/** JPEG qualities tried in turn until the image fits 2 MB (the first is the spec's 0.85). */
const QUALITIES = [0.85, 0.7, 0.55];

function toBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] ?? "");
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

const toBlob = (canvas: HTMLCanvasElement, quality: number) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/jpeg", quality),
  );

/** Re-encoding through a canvas drops EXIF, including GPS. */
async function canvasToImage(canvas: HTMLCanvasElement): Promise<UploadImage> {
  for (const q of QUALITIES) {
    const data = await toBase64(await toBlob(canvas, q));
    if (data.length <= MAX_ITINERARY_IMAGE_B64) return { mediaType: "image/jpeg", data };
  }
  throw new Error("image too large");
}

function newCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

async function loadBitmap(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if ("createImageBitmap" in window) {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    return { source: bmp, width: bmp.width, height: bmp.height, close: () => bmp.close() };
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, close: () => undefined };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function downscaleImage(file: File): Promise<UploadImage> {
  const bmp = await loadBitmap(file);
  try {
    const { width, height } = fitSize(bmp.width, bmp.height, MAX_IMAGE_EDGE);
    const canvas = newCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("canvas");
    ctx.fillStyle = "#fff"; // JPEG has no alpha
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bmp.source, 0, 0, width, height);
    return await canvasToImage(canvas);
  } finally {
    bmp.close();
  }
}

/** PDF: text layer first; a scan (too little text) is rendered to at most 3 JPEG pages. */
export async function readPdf(file: File): Promise<ReadResult> {
  const pdfjs = await import("pdfjs-dist"); // lazy: only when the user picks a PDF
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
  // pdf.js 6 no longer evaluates generated code and dropped the `isEvalSupported` type; passing it keeps the
  // spec's intent for any build that still reads it.
  const params = { data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false } as Parameters<typeof pdfjs.getDocument>[0];
  const task = pdfjs.getDocument(params);
  const doc = await task.promise;
  try {
    const pages = Math.min(doc.numPages, MAX_PDF_PAGES);
    const result = (source: ItinerarySource, n = pages): ReadResult => ({
      source,
      pages: n,
      ...(doc.numPages > MAX_PDF_PAGES ? { truncatedTo: MAX_PDF_PAGES } : {}),
    });
    const texts: string[] = [];
    for (let n = 1; n <= pages; n++) {
      const content = await (await doc.getPage(n)).getTextContent();
      // Lines: items on one baseline are joined, a new baseline (hasEOL or a jump) starts a new line.
      let text = "";
      for (const item of content.items) {
        if (!("str" in item)) continue;
        text += item.str + (item.hasEOL ? "\n" : " ");
      }
      texts.push(text);
    }
    if (hasTextLayer(texts)) return result({ kind: "text", text: texts.join("\n") });

    const scanPages = Math.min(pages, MAX_SCAN_PAGES);
    const images: UploadImage[] = [];
    for (let n = 1; n <= scanPages; n++) {
      const page = await doc.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = fitSize(base.width, base.height, MAX_IMAGE_EDGE).width / base.width;
      const viewport = page.getViewport({ scale });
      const canvas = newCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      await page.render({ canvas, viewport }).promise;
      images.push(await canvasToImage(canvas));
    }
    return result({ kind: "images", images }, scanPages);
  } finally {
    void task.destroy();
  }
}
