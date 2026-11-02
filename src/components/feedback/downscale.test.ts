import { describe, expect, it, vi } from "vitest";
import { downscaleScreenshot, type CanvasLike, type DownscaleEnv } from "./downscale";

function env(opts: { w?: number; h?: number; webp?: boolean; sizes: number[]; decodeFails?: boolean }) {
  const calls: string[] = [];
  const close = vi.fn();
  let i = 0;
  const canvas: CanvasLike = {
    width: 0,
    height: 0,
    getContext: () => ({
      fillStyle: "",
      fillRect: () => void calls.push("fill"),
      drawImage: () => void calls.push("draw"),
    }),
    toBlob: (cb, type) => {
      calls.push(type);
      const size = opts.sizes[Math.min(i++, opts.sizes.length - 1)];
      const t = type === "image/webp" && opts.webp === false ? "image/png" : type;
      cb(new Blob([new Uint8Array(size)], { type: t }));
    },
  };
  const e: DownscaleEnv = {
    decode: async () => {
      if (opts.decodeFails) throw new Error("x");
      return { width: opts.w ?? 3200, height: opts.h ?? 1600, close };
    },
    createCanvas: () => canvas,
  };
  return { e, canvas, calls, close };
}

describe("downscaleScreenshot", () => {
  it("scales and returns webp", async () => {
    const { e, canvas, close } = env({ sizes: [1000] });
    const r = await downscaleScreenshot(new Blob(["x"]), e);
    expect(r.ok && r.blob.type).toBe("image/webp");
    expect([canvas.width, canvas.height]).toEqual([1600, 800]);
    expect(close).toHaveBeenCalled();
  });
  it("terminates with too_large when nothing fits", async () => {
    const { e, calls } = env({ sizes: [3 * 1024 * 1024] });
    const r = await downscaleScreenshot(new Blob(["x"]), e);
    expect(r).toEqual({ ok: false, reason: "too_large" });
    expect(calls.filter((c) => c === "image/webp")).toHaveLength(4);
  });
  it("lowers quality until it fits", async () => {
    const { e } = env({ sizes: [3 * 1024 * 1024, 500] });
    expect((await downscaleScreenshot(new Blob(["x"]), e)).ok).toBe(true);
  });
  it("fills white once before a JPEG fallback", async () => {
    const { e, calls } = env({ webp: false, sizes: [3 * 1024 * 1024, 100] });
    const r = await downscaleScreenshot(new Blob(["x"]), e);
    expect(r.ok && r.blob.type).toBe("image/jpeg");
    expect(calls.filter((c) => c === "fill")).toHaveLength(1);
    expect(calls.indexOf("fill")).toBeGreaterThan(calls.indexOf("draw"));
  });
  it("reports bad_image when decoding fails", async () => {
    expect(await downscaleScreenshot(new Blob(["x"]), env({ sizes: [1], decodeFails: true }).e)).toEqual({ ok: false, reason: "bad_image" });
  });
});
