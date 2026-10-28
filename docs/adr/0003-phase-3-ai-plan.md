# ADR 0003: Phase 3 AI plan generation, iteration and versions

Status: proposed (written overnight, defaults pending review by Alex) · Date: 2026-10-28 · Spec: `docs/specs/phase-3-ai-plan.md` (section 13 lists every default)

## Context
Phase 3 turns a trip (destination + length, optional group, purpose and facts from phase 2) into a daily itinerary that the user can refine. Ground rules: facts come from APIs/code, never the LLM (1); deterministic first, minimal tokens: Haiku for purpose tags, one Sonnet call for the itinerary, iteration patches only affected days, Zod validation, prompt caching, usage logged (2); all context optional (3); ages computed, never stored (4); owner-only data (6). Phases 4 (flights) and 5 (items, costs, share, PDF) must extend the plan without breaking it. Runs on Vercel Hobby (300 s functions) and Supabase Free.

## Decisions

1. **The stored plan is assembled by code around a small LLM core.** Sonnet returns only summary, days (stops with optional time windows, activities, note/warn/best), notes, open items and packing, through structured outputs validated by Zod. Code adds the header (title, timing, group summary by age band), dates, the referenced places and a facts digest, and enforces limits. The plan JSON is a loose Zod object with reserved optional keys `flights`, `items`, `costs` that phases 4/5 fill in additively (`v` stays 1).
2. **The LLM can reference places only through short ids (`p1..pN`) from the facts input**; code maps them to OSM keys and drops unknown ids. Prices, opening hours, flight data and drive times are forbidden in prose and checked by evals; missing data becomes an open item. Fixed times the user wrote (port calls) are copied into stop windows flagged `fixed`.
3. **Compact canonical JSON input without volatile fields**, no names or birthdates (ages via `ageOn` only), purpose as Haiku tags instead of raw text, top 40 candidate places, daylight as local times, gateway airports and straight-line distances computed in code. The same canonical serializer feeds the hash and the prompt, so cache prefixes survive a jsonb round trip.
4. **Haiku tags are computed lazily at the first generation** and cached in the existing `trip_purposes.parsed_tags/parsed_hash/parsed_at` (secret-key write), valid while the content hash matches. Tag interests also widen the places query (still max 4 interests).
5. **One plan per trip, append-only `plan_versions`.** Each version stores the plan, the exact LLM input plus place index, the input hash, the feedback or edit that produced it, the changed day numbers, model and cost. Version numbers come from a trigger that locks the `plans` row. Restore creates a new version (history is never rewritten). Last 30 versions kept. Same-owner composite FKs cascade from `trips`, so the 18-month purge removes plans; plan activity now extends retention.
6. **Iteration = day patch.** The model returns only the changed days as full replacements plus a one-line reply; code keeps every other day as the identical object from the base version, rejects days outside the user's scope and records `changed_days`. The patch reuses the stored input of the base version, so the cached prefix (system rules + input) is hit within 5 minutes and facts are not refetched. Swapping days and choosing the best day are code-only edits.
7. **Cost control in layers:** input-hash dedupe per plan (no second call for identical input), per-user daily budgets from `ai_usage` in micro-dollars (user $0.50, admin $2, shared demo account $0.20, global $5), an `AI_ENABLED` kill switch, a DB generation lock (`plans.busy_until`), in-memory rate limits, effort `medium`/`low`, and an Anthropic console limit. `ai_usage` holds metadata only and is readable by its owner and by admins.
8. **Long calls run in route handlers with `maxDuration = 300`**, without forwarding the browser's abort signal; the client shows staged progress and polls the plan state while the lock is held. No streaming in phase 3.
9. **No refusal fallback and no automatic retries**; failures are logged with their usage and surfaced as typed errors.
10. **Evals are deterministic checks on recorded responses in CI**, plus a live runner guarded by a local gitignored cost ledger (cap $1.00 for the night).

## Consequences
- Plan quality depends on OSM coverage; interests without candidates yield generic suggestions without source links.
- Distances are straight-line until driving times (ORS) and verified arrival airports (phase 4) arrive.
- A trip edit marks the plan "outdated" (banner only); length or start-date changes require regeneration before iterating.
- Stored inputs contain ages as of generation. They are a record of what was sent to the model and are never read back as a person's age (rule 4 still holds for all live views).
- Users can write plan rows for themselves through the Data API (RLS, no secret key); the server re-validates with Zod on read.
- Phase 5 share links point at `plans` and render the latest version server-side; phase 5 items attach to days by `n` and to places by OSM key.
