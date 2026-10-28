import { z } from "zod";

/** Longest free-text group description (travel group and one-off trip group). */
export const GROUP_TEXT_MAX = 1000;
/** Raw group text is cut to this when it goes into the plan as notes (no structure available). */
export const GROUP_TEXT_FALLBACK_CHARS = 600;
export const MAX_PARSED_TRAVELLERS = 30;

export const TravellerRole = z.enum(["adult", "child", "infant"]);
export type TravellerRole = z.infer<typeof TravellerRole>;

/**
 * One set of people with the same age statement, as Haiku read them from the group text.
 * `exact`/`approx` carry `age`; `relativeToMe` carries `ageOffset` (years, 0 = same age as the writer).
 * Ages are only what the text says; the age for the travel date is computed in code.
 */
export const Traveller = z.object({
  count: z.number().int().min(1).max(50),
  ageMode: z.enum(["exact", "approx", "relativeToMe"]).optional(),
  age: z.number().int().min(0).max(120).optional(),
  ageOffset: z.number().int().min(-60).max(60).optional(),
  label: z.string().max(60).optional(),
  role: TravellerRole.optional(),
});
export type Traveller = z.infer<typeof Traveller>;

/** Cached Haiku parse of a group text (validated by us, never trusted as-is). */
export const GroupParse = z.object({
  v: z.literal(1),
  travellers: z.array(Traveller).max(MAX_PARSED_TRAVELLERS),
  notes: z.array(z.string().max(200)).max(10),
});
export type GroupParse = z.infer<typeof GroupParse>;
