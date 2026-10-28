import { createHash } from "node:crypto";
import { GROUP_PROMPT_VERSION, MODEL_PLAN, PLAN_PROMPT_VERSION, TAGS_PROMPT_VERSION } from "@/lib/domain/ai";
import type { TripPurpose } from "@/lib/domain/purpose";
import { isInterestKey } from "@/lib/facts/interest-sources";
import type { PlanInput } from "./input";

function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canon(x)));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = canon(x);
    }
    return out;
  }
  return v;
}

/** Sorted keys, no whitespace, `undefined` dropped. Used for hashes and every JSON block in a prompt. */
export function canonicalJson(v: unknown): string {
  return JSON.stringify(canon(v)) ?? "null";
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** sha256 hex of `{ p: PLAN_PROMPT_VERSION, m: MODEL_PLAN, input }`. */
export function planInputHash(llm: PlanInput): string {
  return sha256(canonicalJson({ p: PLAN_PROMPT_VERSION, m: MODEL_PLAN, input: llm }));
}

/** Guided interests that are not interest keys (free text). */
export function customGuidedInterests(p: Pick<TripPurpose, "guided">): string[] {
  return (p.guided?.interests ?? []).filter((i) => !isInterestKey(i));
}

/** sha256 hex of `{ p: TAGS_PROMPT_VERSION, text, constraints, custom }`. */
export function purposeTagsHash(p: Pick<TripPurpose, "text" | "constraints" | "guided">): string {
  return sha256(
    canonicalJson({
      p: TAGS_PROMPT_VERSION,
      text: p.text?.trim() || null,
      constraints: p.constraints ?? [],
      custom: customGuidedInterests(p),
    }),
  );
}

/** sha256 hex of `{ p: GROUP_PROMPT_VERSION, text }` (whitespace-normalised): the cache key of a group text parse. */
export function groupTextHash(text: string): string {
  return sha256(canonicalJson({ p: GROUP_PROMPT_VERSION, text: text.replace(/\s+/g, " ").trim() }));
}
