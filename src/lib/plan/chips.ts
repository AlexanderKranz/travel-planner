import type { PlanChip } from "@/lib/domain/plan";

/** Chip → English instruction for the patch prompt (spec 4.3). */
export const CHIP_INSTRUCTIONS: Record<PlanChip, string> = {
  more_rest: "Add rest or free time; reduce activities per day by about a third.",
  more_active: "Add more active or sightseeing time where daylight and windows allow.",
  less_travel: "Reduce moves between stops; prefer places with small km.",
  kid_friendly: "Prefer child-friendly activities and shorter walks; keep group traits.",
  rainy_day: "Assume rain: prefer indoor activities and short outdoor slots.",
  redo_day: "Rewrite the given days with different activities.",
};
