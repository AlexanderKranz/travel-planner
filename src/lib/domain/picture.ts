import { z } from "zod";

/**
 * Destination picture (Wikimedia Commons). Facts-from-APIs: only real Commons data.
 * `author` is plain text (HTML stripped) and null only for CC0 / public domain files with no named author.
 * `licenseUrl` is null for public domain files without a licence page.
 */
export const DestinationPicture = z.object({
  url: z.string().url().max(500),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  author: z.string().min(1).max(160).nullable(),
  licenseName: z.string().min(1).max(60),
  licenseUrl: z.string().url().max(300).nullable(),
  sourcePageUrl: z.string().url().max(500),
  kind: z.enum(["banner", "image"]),
  /** Commons file name without "File:" (for alt text or debugging, not for display). */
  title: z.string().min(1).max(250),
});
export type DestinationPicture = z.infer<typeof DestinationPicture>;

/** What the page gets: the picture plus when the cached lookup was made (shown as check date). */
export type DestinationPictureResult = DestinationPicture & { fetchedAt: string };
