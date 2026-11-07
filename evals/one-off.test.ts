/**
 * E10 (spec find-destinations section 13.7, CI, no network): the golf fixture's purpose text typed as a one-off, with
 * the recorded tags, gives the same IdeaInput and hash as the saved purpose. Serving that saved list to the typed
 * request relabels it (the draft then has an empty purpose and the text in notes); serving it to the saved purpose
 * again restores the purpose.
 */
import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { PurposeTags } from "@/lib/domain/plan";
import { ideasInputHash } from "@/lib/discover/hash";
import { buildIdeaInput } from "@/lib/discover/input";
import { ownAgeRefs } from "@/lib/group";
import { oneOffLabel, oneOffPurpose, oneOffTagsHash } from "@/lib/discover/one-off";
import { buildTripDraft } from "@/lib/discover/prefill";
import { purposeTagsHash } from "@/lib/plan/hash";
import { EVAL_PROFILE_BIRTHDATE, EVAL_TODAY, evalPurpose, FIXTURES } from "./build-input";
import { readRecording } from "./recorded";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/server/supabase/admin", () => ({ createSupabaseAdminClient: () => ({ from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: async () => ({ data: [{ id: "s1" }], error: null }) }) }) }) }) }) }));

import { adoptSource, rowToSearch, type SearchRow } from "@/lib/server/discover/store";

const tags = readRecording<PurposeTags>("golf", "tags")?.output ?? null;
const text = FIXTURES.golf.purpose!.text!;
const SAVED_ID = "22222222-2222-4222-8222-222222222222";

const ideaInput = (purpose: ReturnType<typeof oneOffPurpose>) =>
  buildIdeaInput({ lang: "de", purpose, months: [3], origins: ["FRA"], radiusKm: 2128, group: null, ageRefs: ownAgeRefs(EVAL_PROFILE_BIRTHDATE), today: EVAL_TODAY });

/** In-memory single-row table: applies the update patch and returns the row, like PostgREST with `select()`. */
function memoryDb(initial: SearchRow) {
  let current = initial;
  const writes: Record<string, unknown>[] = [];
  const sb = {
    from: () => ({
      update(patch: Record<string, unknown>) {
        writes.push(patch);
        current = { ...current, ...patch } as SearchRow;
        const q = { eq: () => q, select: () => q, maybeSingle: async () => ({ data: current, error: null }) };
        return q;
      },
    }),
  } as unknown as SupabaseClient;
  return { sb, writes, row: () => current };
}

describe("E10: a typed one-off equals the saved purpose", () => {
  it("has recorded tags to work with", () => {
    expect(tags).not.toBeNull();
  });

  it("the same IdeaInput and hash as the saved purpose with the same recorded tags", () => {
    const saved = evalPurpose("golf", tags)!;
    const typed = oneOffPurpose(text, tags);
    expect(ideaInput(typed)).toEqual(ideaInput(saved));
    expect(ideasInputHash(ideaInput(typed))).toBe(ideasInputHash(ideaInput(saved)));
  });

  it("the typed text has its own tags hash (no constraints), equal to a saved purpose of the same text only", () => {
    expect(oneOffTagsHash(text)).toBe(purposeTagsHash({ text, constraints: [], guided: {} }));
    expect(oneOffTagsHash(text)).not.toBe(purposeTagsHash(evalPurpose("golf", null)!)); // the fixture purpose has constraints
  });

  it("serving the saved list to the typed request relabels it; the draft has the text as one-off purpose, notes empty; serving it to the saved purpose restores it", async () => {
    const hash = ideasInputHash(ideaInput(evalPurpose("golf", tags)!));
    const initial = {
      id: "11111111-1111-4111-8111-111111111111", purpose_id: SAVED_ID, group_id: null, purpose_name: "Golftrip", purpose_text: null, locale: "de",
      months: [3], origins: ["FRA"], max_flight_hours: 3, radius_km: 2128, travel_mode: "flight", max_drive_hours: null, home_name: null,
      home_lat: null, home_lon: null, input_hash: hash, input: ideaInput(evalPurpose("golf", tags)!), status: "done", busy_until: null, rounds: 1,
      cards: [], drops: {}, error_code: null, model: null, cost_micro_usd: 0, created_at: "2026-10-28T08:00:00Z", updated_at: "2026-10-28T08:00:00Z",
    } as SearchRow;
    const db = memoryDb(initial);
    const card = { kind: "region" as const, geoId: 2513918, placeName: "Marbella", name: "Costa del Sol", admin1: "Andalusia", reason: "Flache Plätze" };

    // saved purpose: no relabel, notes empty
    const first = await adoptSource(db.sb, "u1", rowToSearch(initial), { kind: "saved", purposeId: SAVED_ID, name: "Golftrip" });
    expect(first.relabelled).toBe(false);
    expect(buildTripDraft(first.search, card, ["FRA"])).toMatchObject({ purposeId: SAVED_ID, notes: "" });

    // typed request: relabelled
    const typed = await adoptSource(db.sb, "u1", first.search, { kind: "text", text, tags });
    expect(typed.relabelled).toBe(true);
    expect(db.row()).toMatchObject({ purpose_id: null, purpose_text: text, purpose_name: oneOffLabel(text) });
    const draft = buildTripDraft(typed.search, card, ["FRA"]);
    expect(draft.purposeId).toBe("__text");
    expect(draft.purposeText).toBe(text);
    expect(draft.notes).toBe("");
    expect(JSON.stringify(draft)).not.toContain("Flache Plätze");

    // the same typed request again: nothing to write
    const writes = db.writes.length;
    expect((await adoptSource(db.sb, "u1", typed.search, { kind: "text", text, tags })).relabelled).toBe(false);
    expect(db.writes.length).toBe(writes);

    // saved request again: the purpose is back, the text is gone
    const back = await adoptSource(db.sb, "u1", typed.search, { kind: "saved", purposeId: SAVED_ID, name: "Golftrip" });
    expect(back.relabelled).toBe(true);
    expect(db.row()).toMatchObject({ purpose_id: SAVED_ID, purpose_text: null, purpose_name: "Golftrip" });
    expect(buildTripDraft(back.search, card, ["FRA"])).toMatchObject({ purposeId: SAVED_ID, notes: "" });
  });
});
