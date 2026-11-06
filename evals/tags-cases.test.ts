/** CI replay of the recorded addendum-1 tag cases (no network): finishTags (normalizeTags + family fallback) + the case checks. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TAGS_PROMPT_VERSION } from "@/lib/domain/ai";
import { purposeTagsHash } from "@/lib/plan/hash";
import { finishTags, type normalizeTags } from "@/lib/server/ai/purpose-tags";
import { formatResults } from "./evaluate";
import { RECORDED_DIR } from "./recorded";
import { TAGS_CASES, casePurpose } from "./tags-cases";

vi.mock("server-only", () => ({}));

const FILE = join(RECORDED_DIR, "tags-cases.json");
type Rec = { promptVersion: string; cases: { id: string; hash: string; wire: Parameters<typeof normalizeTags>[0] }[] };
const rec: Rec | null = existsSync(FILE) ? (JSON.parse(readFileSync(FILE, "utf8")) as Rec) : null;

describe.runIf(!!rec)("recorded purpose tag cases (addendum 1)", () => {
  it("covers every case with the current prompt version", () => {
    expect(rec!.promptVersion).toBe(TAGS_PROMPT_VERSION);
    expect(rec!.cases.map((c) => c.id).sort()).toEqual(TAGS_CASES.map((c) => c.id).sort());
  });
  it.each(TAGS_CASES)("$id", (c) => {
    const r = rec!.cases.find((x) => x.id === c.id)!;
    if (r.hash !== purposeTagsHash(casePurpose(c))) console.warn(`[tags-cases] ${c.id} was recorded for another text or prompt version`);
    const rs = c.check(finishTags(r.wire, casePurpose(c)));
    expect(rs.filter((x) => !x.ok), formatResults(c.id, rs)).toEqual([]);
  });
});
