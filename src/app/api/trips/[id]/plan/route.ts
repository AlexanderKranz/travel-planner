import { NextResponse } from "next/server";
import { z } from "zod";
import { Locale } from "@/lib/domain/profile";
import { generatePlan, loadPlanContext, loadPlanState } from "@/lib/server/plan-pipeline";
import { badRequest, NO_STORE, respond } from "./respond";

// Vercel Hobby with Fluid compute: default and maximum are 300 s. Sonnet may need 30-90 s.
export const maxDuration = 300;

const Body = z.object({
  locale: Locale,
  force: z.boolean().optional(),
  fresh: z.boolean().optional(),
});

/** GET /api/trips/[id]/plan[?v=n] -> { state: PlanState } (login required, RLS). Polled by the runner while busy. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const v = new URL(request.url).searchParams.get("v");
  const version = v === null ? undefined : Number(v);
  if (version !== undefined && !(Number.isInteger(version) && version >= 1)) return badRequest();
  const loaded = await loadPlanContext(id);
  if (!loaded.ok) return respond(loaded);
  const s = await loadPlanState(loaded.ctx, version);
  return s.ok ? NextResponse.json({ state: s.state }, { headers: NO_STORE }) : respond(s);
}

/**
 * POST /api/trips/[id]/plan {locale, force?, fresh?} -> generate. One request does everything: places, facts, plan
 * (`force`: skip waiting for places; `fresh`: a new AI version even when the input is unchanged). The client abort
 * signal is deliberately NOT forwarded: the server finishes and saves the plan even if the browser leaves (the
 * runner or a later visit polls GET). Old clients may still send `placesLoaded`; it is ignored (zod strips it) and
 * harmless, because the places they just loaded are in the cache.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = Body.safeParse(await request.json().catch(() => null));
  if (!body.success) {
    // Auth first so anonymous callers learn nothing about the shape.
    const loaded = await loadPlanContext(id);
    return loaded.ok ? badRequest() : respond(loaded);
  }
  const { locale, force, fresh } = body.data;
  return respond(await generatePlan(id, locale, {
      force: force === true,
      fresh: fresh === true,
      // Only read (never forwarded as an abort) when places are pending: a gone client cannot see the retry prompt.
      clientGone: () => request.signal.aborted,
    }));
}

