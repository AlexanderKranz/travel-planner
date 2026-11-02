import { SCREENSHOT_QUALITIES, fitWithin, fitsServerLimit } from "@/lib/feedback-client";

export type DownscaleResult = { ok: true; blob: Blob } | { ok: false; reason: "bad_image" | "too_large" };

type Ctx = { fillStyle: string; fillRect(x: number, y: number, w: number, h: number): void; drawImage(b: never, x: number, y: number, w: number, h: number): void };
export type CanvasLike = { width: number; height: number; getContext(t: "2d"): Ctx | null; toBlob(cb: (b: Blob | null) => void, type: string, q: number): void };
export type DownscaleEnv = {
  decode(file: Blob): Promise<{ width: number; height: number; close(): void }>;
  createCanvas(): CanvasLike;
};

const browserEnv: DownscaleEnv = {
  decode: (file) => createImageBitmap(file, { imageOrientation: "from-image" }),
  createCanvas: () => document.createElement("canvas") as unknown as CanvasLike,
};

const toBlob = (c: CanvasLike, type: string, q: number) => new Promise<Blob | null>((res) => c.toBlob(res, type, q));

/**
 * Decodes the file, draws it on a canvas (max 1600 px long edge) and re-encodes as WebP (JPEG where the browser has
 * no WebP encoder; the canvas is then filled white first so transparency does not turn black). The re-encode drops
 * all metadata, including EXIF/GPS. Tries lower qualities until it fits 2 MB; the loop is bounded by the quality list.
 */
export async function downscaleScreenshot(file: Blob, env: DownscaleEnv = browserEnv): Promise<DownscaleResult> {
  let bitmap;
  try {
    bitmap = await env.decode(file);
  } catch {
    return { ok: false, reason: "bad_image" };
  }
  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height);
    const canvas = env.createCanvas();
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { ok: false, reason: "bad_image" };
    const paint = (white: boolean) => {
      if (white) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, width, height);
      }
      ctx.drawImage(bitmap as never, 0, 0, width, height);
    };
    paint(false);
    let white = false;
    for (const q of SCREENSHOT_QUALITIES) {
      let blob = await toBlob(canvas, "image/webp", q);
      if (!blob || blob.type !== "image/webp") {
        // No WebP encoder (the browser returned PNG): JPEG has no alpha, so put the image on white.
        if (!white) {
          paint(true);
          white = true;
        }
        blob = await toBlob(canvas, "image/jpeg", q);
      }
      if (!blob) return { ok: false, reason: "bad_image" };
      if (fitsServerLimit(blob.size)) return { ok: true, blob };
    }
    return { ok: false, reason: "too_large" };
  } finally {
    bitmap.close();
  }
}
