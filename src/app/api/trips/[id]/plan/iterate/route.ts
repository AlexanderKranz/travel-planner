import { z } from "zod";
import { Locale } from "@/lib/domain/profile";
import { iteratePlan, loadPlanContext } from "@/lib/server/plan-pipeline";
import { badRequest, respond } from "../respond";

export const maxDuration = 300;

const Body = z.object({
  locale: Locale,
  baseVersion: z.number().int().min(1),
  feedback: z.unknown(), // validated against PlanFeedback by the pipeline
});

/** POST /api/trips/[id]/plan/iterate {locale, baseVersion, feedback} -> day patch. No client abort signal is forwarded. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    const loaded = await loadPlanContext(id);
    return loaded.ok ? badRequest() : respond(loaded);
  }
  return respond(await iteratePlan(id, body.data.baseVersion, body.data.feedback, body.data.locale));
}
