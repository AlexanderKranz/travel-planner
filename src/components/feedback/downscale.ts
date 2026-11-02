import { SCREENSHOT_QUALITIES, fitWithin, fitsServerLimit } from "@/lib/feedback-client";

export type DownscaleResult = { ok: true; blob: Blob } | { ok: false; reason: "bad_image" | "too_large" };

const toBlob = (c: HTMLCanvasElement, type: string, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));

/**
 * Decodes the file, draws it on a canvas (max 1600 px long edge) and re-encodes as WebP (JPEG where the browser has
 * no WebP encoder). The re-encode drops all metadata, including EXIF/GPS. Tries lower qualities until it fits 2 MB.
 */
export async function downscaleScreenshot(file: File): Promise<DownscaleResult> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return { ok: false, reason: "bad_image" };
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "bad_image" };
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const q of SCREENSHOT_QUALITIES) {
      let blob = await toBlob(canvas, "image/webp", q);
      // Browsers without a WebP encoder return PNG; use JPEG then (PNG would be too large).
      if (!blob || blob.type !== "image/webp") blob = await toBlob(canvas, "image/jpeg", q);
      if (!blob) return { ok: false, reason: "bad_image" };
      if (fitsServerLimit(blob.size)) return { ok: true, blob };
    }
    return { ok: false, reason: "too_large" };
  } finally {
    bitmap.close();
  }
}
