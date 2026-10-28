import { z } from "zod";
import type { Plan } from "./plan";
import type { CostSummary, SharedItem } from "./items";

export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const MAX_LINKS_PER_TRIP = 10;

export const ShareLinkInput = z.object({
  label: z.string().trim().max(60).nullable(),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable(),
  includeItems: z.boolean(),
  includeItemNotes: z.boolean().default(false), // D7: notes may hold booking codes; only with includeItems
});
export type ShareLinkInputParsed = z.infer<typeof ShareLinkInput>;

export type ShareLink = {
  id: string;
  tripId: string;
  label: string | null;
  includeItems: boolean;
  includeItemNotes: boolean;
  expiresAt: string | null;
  createdAt: string;
  viewCount: number;
  lastViewedAt: string | null;
};
export type CreatedShareLink = { link: ShareLink; url: string }; // url only in the create response

/** Input of the share page and the PDF. */
export type PlanDocument = {
  plan: Plan;
  versionNo: number;
  versionAt: string;
  openDone: string[];
  items: SharedItem[] | null; // null = not shared / no items section; notes already null-ed when not shared
  costs: CostSummary | null;
};
