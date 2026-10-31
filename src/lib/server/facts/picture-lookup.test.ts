import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({ item: vi.fn(), claims: vi.fn(), files: vi.fn(), choose: vi.fn() }));
vi.mock("@/lib/integrations/wikipedia", () => ({ fetchWikibaseItem: h.item }));
vi.mock("@/lib/integrations/wikimedia-images", () => ({ fetchImageClaims: h.claims, fetchCommonsFiles: h.files }));
vi.mock("@/lib/facts/picture", () => ({ choosePicture: h.choose }));
vi.mock("../api-cache", () => ({ cached: vi.fn(), peekCache: vi.fn(), cacheKey: () => "k" }));
vi.mock("../supabase/admin", () => ({ createSupabaseAdminClient: vi.fn() }));

const { lookupDestinationPicture } = await import("./picture");

const boom = new Error("timeout");
const lookup = () => lookupDestinationPicture(48.5, 13.4, "Passau", "de");

beforeEach(() => {
  vi.clearAllMocks();
  h.item.mockImplementation(async (_lat, _lon, _name, lang: string) => {
    if (lang === "en") throw boom;
    return { qid: "Q1", latencyMs: 1 };
  });
  h.claims.mockResolvedValue({ banners: ["a.jpg"], images: [], latencyMs: 1 });
  h.files.mockResolvedValue({ files: [], status: 200, latencyMs: 1 });
});

describe("lookupDestinationPicture with one failed language", () => {
  it("keeps a picture found through the other language", async () => {
    h.choose.mockReturnValue({ url: "u" });
    await expect(lookup()).resolves.toMatchObject({ data: { url: "u" } });
  });
  it("throws instead of caching 'none' when no usable picture was found", async () => {
    h.choose.mockReturnValue(null);
    await expect(lookup()).rejects.toBe(boom);
    h.claims.mockResolvedValue({ banners: [], images: [], latencyMs: 1 });
    await expect(lookup()).rejects.toBe(boom);
    h.item.mockImplementation(async (_lat, _lon, _name, lang: string) => {
      if (lang === "en") throw boom;
      return { qid: null, latencyMs: 1 };
    });
    await expect(lookup()).rejects.toBe(boom);
  });
});

describe("lookupDestinationPicture when both languages answered", () => {
  it("returns null, so 'none' is cached", async () => {
    h.item.mockResolvedValue({ qid: null, latencyMs: 1 });
    await expect(lookup()).resolves.toMatchObject({ data: null });
    h.item.mockResolvedValue({ qid: "Q1", latencyMs: 1 });
    h.choose.mockReturnValue(null);
    await expect(lookup()).resolves.toMatchObject({ data: null });
  });
});
