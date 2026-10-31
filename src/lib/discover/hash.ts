import { createHash } from "node:crypto";
import { IDEAS_PROMPT_VERSION, MODEL_IDEAS } from "@/lib/domain/ai";
import { canonicalJson } from "@/lib/plan/hash";
import type { IdeaInput } from "./input";

/**
 * sha256 hex of `{ p: IDEAS_PROMPT_VERSION, m: MODEL_IDEAS, input }` (spec [D6]). The whole input is hashed, so it
 * covers purpose tags, months, airports and exclusions, and also locale, radius and group. Scope of a hit: the same
 * owner, younger than 30 days (the table lookup, not the hash).
 */
export function ideasInputHash(input: IdeaInput): string {
  return createHash("sha256")
    .update(canonicalJson({ p: IDEAS_PROMPT_VERSION, m: MODEL_IDEAS, input }))
    .digest("hex");
}
