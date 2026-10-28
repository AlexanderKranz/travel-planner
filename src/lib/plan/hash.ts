import type { TripPurpose } from "@/lib/domain/purpose";
import type { PlanInput } from "./input";
import { notImplemented } from "./not-implemented";

/** Sorted keys, no whitespace, `undefined` dropped. Used for hashes and every JSON block in a prompt. */
export function canonicalJson(v: unknown): string {
  void v;
  return notImplemented("canonicalJson");
}

/** sha256 hex of `{ p: PLAN_PROMPT_VERSION, m: MODEL_PLAN, input }`. */
export function planInputHash(llm: PlanInput): string {
  void llm;
  return notImplemented("planInputHash");
}

/** sha256 hex of `{ p: TAGS_PROMPT_VERSION, text, constraints, custom }`. */
export function purposeTagsHash(p: Pick<TripPurpose, "text" | "constraints" | "guided">): string {
  void p;
  return notImplemented("purposeTagsHash");
}
