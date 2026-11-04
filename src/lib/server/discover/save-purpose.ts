import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { oneOffTagsHash } from "@/lib/discover/one-off";
import { TripPurposeInput } from "@/lib/domain/purpose";
import { zodIssues, type ActionError } from "@/lib/domain/result";
import { logEvent } from "../events";
import { savePurposeTags } from "../plan-store";
import { insertPurposeRow } from "../purpose-insert";
import { externalWriteAllowed } from "../rate-limit";
import { getUserSession } from "../session";
import { getSearchById, getSearchTags, type StoredSearch } from "./store";

/**
 * "Save as purpose" for a typed one-off search (spec docs/specs/find-destinations.md section 13.4, ADR 0009 decision 5).
 * Copies the text and the tags onto a new purpose, links the search, and never calls the LLM. Idempotent.
 */

const Id = z.string().uuid();
const Body = z.object({ name: TripPurposeInput.shape.name });

export type SavePurposeData = { purposeId: string; name: string; created: boolean };
export type SavePurposeResult =
  | { ok: true; data: SavePurposeData }
  | { ok: false; error: ActionError; issues?: { path: string; message: string }[] };

const err = (error: ActionError, issues?: { path: string; message: string }[]): SavePurposeResult => ({ ok: false, error, ...(issues ? { issues } : {}) });

/** Current name of a purpose (RLS), else the given fallback. */
async function nameOf(sb: SupabaseClient, purposeId: string, fallback: string): Promise<string> {
  const { data } = await sb.from("trip_purposes").select("name").eq("id", purposeId).maybeSingle<{ name: string }>();
  return data?.name ?? fallback;
}

/** An own purpose with exactly this text and no constraints or guided fields (oldest first). */
async function findIdenticalPurpose(sb: SupabaseClient, text: string): Promise<{ id: string; name: string } | null> {
  const { data, error } = await sb
    .from("trip_purposes")
    .select("id, name, guided, constraints")
    .eq("text", text)
    .order("created_at", { ascending: true })
    .limit(20)
    .returns<{ id: string; name: string; guided: unknown; constraints: string[] }[]>();
  if (error) throw new Error("purpose read failed");
  const guidedEmpty = (g: unknown) => !!g && typeof g === "object" && !Array.isArray(g) && Object.keys(g).length === 0;
  return (data ?? []).find((p) => p.constraints.length === 0 && guidedEmpty(p.guided)) ?? null;
}

/** Conditional on the text read earlier, so a relabel in between is not overwritten. True = this call linked the search. */
async function link(sb: SupabaseClient, searchId: string, purposeId: string, name: string, text: string): Promise<boolean> {
  const { data, error } = await sb
    .from("destination_searches")
    .update({ purpose_id: purposeId, purpose_name: name.slice(0, 80) })
    .eq("id", searchId)
    .is("purpose_id", null)
    .eq("purpose_text", text)
    .select("id");
  if (error) throw new Error("search write failed");
  return data.length === 1;
}

export async function saveSearchAsPurpose(id: string, raw: unknown): Promise<SavePurposeResult> {
  const session = await getUserSession();
  if (!session) return err("unauthenticated");
  if (!Id.safeParse(id).success) return err("not_found");
  const body = Body.safeParse(raw);
  if (!body.success) return err("invalid", zodIssues(body.error).slice(0, 10));
  if (!externalWriteAllowed(session.userId)) return err("rate_limited");
  const sb = session.supabase as SupabaseClient;
  const userId = session.userId;
  let insertedId: string | null = null;

  try {
    const row: StoredSearch | null = await getSearchById(sb, id);
    if (!row) return err("not_found");
    // A saved-purpose request took the row over meanwhile: there is no typed text to save any more.
    if (row.purposeText === null) return err("conflict");
    if (row.status === "running") return err("busy");
    const text = row.purposeText;

    // Second click or second tab: already linked.
    if (row.purposeId !== null) {
      return { ok: true, data: { purposeId: row.purposeId, name: await nameOf(sb, row.purposeId, row.purposeName), created: false } };
    }

    let purposeId: string;
    let name: string;
    let created = false;
    let tagged = false;
    const identical = await findIdenticalPurpose(sb, text);
    if (identical) {
      purposeId = identical.id;
      name = identical.name;
    } else {
      const parsed = TripPurposeInput.parse({ name: body.data.name, text, guided: {}, constraints: [] });
      const ins = await insertPurposeRow(sb, parsed);
      if (ins.error) return err("failed");
      purposeId = insertedId = ins.data.id;
      name = ins.data.name;
      created = true;
      // Tags made for exactly this text are copied: the hash then equals purposeTagsHash of the new purpose. No Haiku call.
      const stored = await getSearchTags(sb, id);
      const hash = oneOffTagsHash(text);
      if (stored && stored.hash === hash) tagged = (await savePurposeTags(userId, purposeId, stored.tags, hash)) !== null;
    }

    if (await link(sb, id, purposeId, name, text)) {
      await logEvent({ event: "destination.purpose_saved", userId, props: { created, linkedExisting: !created, tagged } });
      return { ok: true, data: { purposeId, name, created } };
    }

    // Lost the race: the search was linked by another request, or relabelled to another source. Our insert goes away.
    if (insertedId) await sb.from("trip_purposes").delete().eq("id", insertedId);
    insertedId = null;
    const again = await getSearchById(sb, id);
    if (!again) return err("not_found");
    if (again.purposeId !== null) {
      return { ok: true, data: { purposeId: again.purposeId, name: await nameOf(sb, again.purposeId, again.purposeName), created: false } };
    }
    return err("conflict");
  } catch {
    if (insertedId) await sb.from("trip_purposes").delete().eq("id", insertedId).then(undefined, () => undefined);
    await logEvent({ event: "destination.search_failed", level: "warn", userId, props: { reason: "save_purpose_exception" } });
    return err("failed");
  }
}
