import { z } from "zod";
import { optionalText } from "./common";

export const PurposeGuided = z
  .object({
    v: z.literal(1),
    pace: z.enum(["relaxed", "balanced", "packed"]).optional(),
    /** Keys from INTEREST_KEYS or custom text. */
    interests: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
    budget: z.enum(["low", "mid", "high", "luxury"]).optional(),
    accommodation: z
      .array(z.enum(["hotel", "apartment", "cruise_cabin", "camping", "any"]))
      .max(5)
      .optional(),
    rooms: z.enum(["shared", "single_rooms"]).optional(),
  })
  .partial({ v: true });
export type PurposeGuided = z.infer<typeof PurposeGuided>;

export const MAX_CONSTRAINTS = 30;

export const TripPurposeInput = z.object({
  name: z.string().trim().min(1).max(80),
  text: optionalText(4000),
  guided: PurposeGuided.default({}),
  constraints: z.array(z.string().trim().min(1).max(200)).max(MAX_CONSTRAINTS).default([]),
});
export type TripPurposeInput = z.input<typeof TripPurposeInput>;
export type TripPurposeParsed = z.output<typeof TripPurposeInput>;

export type TripPurpose = {
  id: string;
  name: string;
  text?: string;
  guided: PurposeGuided;
  constraints: string[];
  createdAt: string;
  updatedAt: string;
};
