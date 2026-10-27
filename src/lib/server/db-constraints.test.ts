import { describe, expect, it } from "vitest";
import { GroupEntry } from "@/lib/domain/group";
import { entryToRow, type GroupEntryWrite } from "./group-mapping";

/**
 * TypeScript mirror of the CHECK constraints in
 * supabase/migrations/20261027120006_travel_groups.sql (group_entries).
 * Guards against drift: everything Zod accepts and entryToRow() produces must satisfy
 * the DB constraints, otherwise a user gets "failed" for a valid form. If a constraint
 * in the migration changes, change it here too.
 */
function violations(r: GroupEntryWrite): string[] {
  const v: string[] = [];
  const isMember = r.kind === "member";
  if (!(r.count >= 1 && r.count <= 50)) v.push("count_range");
  if (!(isMember || (r.name === null && r.birthdate === null && !r.is_self))) v.push("composition_shape");
  if (!(!isMember || r.count === 1)) v.push("member_single");
  if (!(!isMember || r.is_self || r.name !== null)) v.push("member_identity");
  if (!(!r.is_self || (r.name === null && r.birthdate === null && r.age_mode === null))) v.push("self_shape");
  if (!(r.birthdate === null || r.age_mode === null)) v.push("birthdate_xor_age");
  if (!(r.age_mode !== null || (r.age === null && r.age_as_of === null))) v.push("age_requires_mode");
  if (
    !(
      r.age_mode === null ||
      !["exact", "approx"].includes(r.age_mode) ||
      (r.age !== null && r.age_as_of !== null)
    )
  )
    v.push("stated_age_complete");
  if (!(r.age_mode === null || r.age_mode !== "relativeToMe" || (r.age === null && r.age_as_of === null)))
    v.push("relative_no_age");
  if (r.label !== null && r.label.length > 60) v.push("label_len");
  if (r.name !== null && r.name.length > 80) v.push("name_len");
  if (r.notes !== null && r.notes.length > 1000) v.push("notes_len");
  return v;
}

const candidates: unknown[] = [
  { kind: "composition", count: 5 },
  { kind: "composition", count: 50, age: { ageMode: "approx", age: 45 } },
  { kind: "composition", count: 1, age: { ageMode: "relativeToMe" } },
  { kind: "composition", count: 2, age: { ageMode: "exact", age: 0 }, label: "Kleinkind" },
  { kind: "composition", count: 2, label: "  ", notes: "   " },
  { kind: "member", isSelf: true },
  { kind: "member", isSelf: true, label: "ich", notes: "x" },
  { kind: "member", name: "Tom" },
  { kind: "member", name: "Tom", birthdate: "1980-05-17" },
  { kind: "member", name: "Tom", age: { ageMode: "exact", age: 120 } },
  { kind: "member", name: "Sohn", age: { ageMode: "approx", age: 4 }, traits: { needsNap: true } },
  { kind: "member", name: "Oma", age: { ageMode: "relativeToMe" } },
  { kind: "member", name: "A".repeat(80), label: "L".repeat(60), notes: "n".repeat(1000) },
  // inputs Zod must reject (so they never reach the DB)
  { kind: "member" },
  { kind: "member", isSelf: true, name: "x" },
  { kind: "member", name: "Tom", birthdate: "1980-05-17", age: { ageMode: "exact", age: 3 } },
  { kind: "composition", count: 0 },
  { kind: "composition", count: 51 },
  { kind: "composition", count: 2, name: "x" },
];

describe("Zod -> entryToRow -> DB CHECK constraints", () => {
  for (const [i, candidate] of candidates.entries()) {
    const parsed = GroupEntry.safeParse(candidate);
    if (!parsed.success) {
      it(`#${i} rejected by Zod (never reaches the DB)`, () => {
        expect(parsed.success).toBe(false);
      });
      continue;
    }
    for (const existing of [undefined, { age_mode: "exact" as const, age: 3, age_as_of: "2020-01-01" }]) {
      it(`#${i} produces a row the DB accepts${existing ? " (update path)" : ""}`, () => {
        expect(violations(entryToRow(parsed.data, 0, "2026-10-27", existing))).toEqual([]);
      });
    }
  }

  it("the mirror really detects violations", () => {
    const bad = { ...entryToRow(GroupEntry.parse({ kind: "member", name: "x" }), 0, "2026-10-27"), age_mode: "exact" as const };
    expect(violations(bad)).toContain("stated_age_complete");
  });
});
