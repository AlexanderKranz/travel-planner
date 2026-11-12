import "server-only";
import { createHash } from "node:crypto";
import { MODEL_TAGS, type AiCtx, type AiResult } from "@/lib/domain/ai";
import { normalizeExtract, WireItinerary, type NormalizedExtract } from "@/lib/itinerary/normalize";
import { canonicalJson } from "@/lib/plan/hash";
import { ITINERARY_PROMPT_VERSION, ITINERARY_RULES } from "@/lib/plan/itinerary-prompt";
import { callStructured, type ImageMediaType, type RequestBlock, type StructuredRequest } from "./client";

export const ITINERARY_MAX_TOKENS = 1500;

/**
 * What the model receives: prefiltered text (a document or the trip notes; the source makes no difference to the
 * prompt), or up to 3 downscaled images. The text must already be prefiltered (`prefilterItinerary`).
 */
export type ItineraryPayload =
  | { kind: "text"; text: string }
  | { kind: "images"; images: { mediaType: ImageMediaType; data: string }[] };

/**
 * Cache key in `itinerary_extracts` ([D5]): sha256 of prompt version + model + the exact payload sent to the model
 * (the prefiltered text, or the image bytes after downscaling). Not the original file: the server never sees it.
 */
export function itineraryHash(p: ItineraryPayload): string {
  return createHash("sha256").update(canonicalJson({ p: ITINERARY_PROMPT_VERSION, m: MODEL_TAGS, payload: p })).digest("hex");
}

export function itineraryRequest(p: ItineraryPayload): StructuredRequest<typeof WireItinerary, RequestBlock> {
  const blocks: RequestBlock[] =
    p.kind === "text"
      ? [{ text: "TEXT\n" + canonicalJson({ text: p.text }) }]
      : // Images first, then the label (the API's recommended order for vision prompts).
        [...p.images.map((image) => ({ image })), { text: `IMAGES ${p.images.length}` }];
  return {
    task: "itinerary_extract",
    model: MODEL_TAGS,
    schema: WireItinerary,
    effort: "low",
    maxTokens: ITINERARY_MAX_TOKENS,
    noThinking: true, // a list copy task; thinking shares max_tokens and ran out on long lists in other Haiku tasks
    system: ITINERARY_RULES,
    blocks,
  };
}

/**
 * One Haiku call: itinerary -> normalized raw stops (our own safeParse, usage logged once by `ctx.onUsage`).
 * Text path: places (within one line), times, dates and day numbers are checked against the text (`not_in_source`,
 * `normalizeExtract`); image path: every stop `from_image`.
 */
export async function extractItineraryStops(p: ItineraryPayload, ctx: AiCtx): Promise<AiResult<NormalizedExtract>> {
  const r = await callStructured(itineraryRequest(p), ctx);
  return r.ok ? { ...r, data: normalizeExtract(r.data, p.kind === "text" ? p.text : null) } : r;
}
