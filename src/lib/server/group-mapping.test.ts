import { describe, expect, it } from "vitest";
import { entryToRow, rowToEntry, type GroupEntryRow } from "./group-mapping";

const TODAY = "2026-10-27";

describe("entryToRow", () => {
  it("sets age_as_of to today for a new stated age", () => {
    const row = entryToRow(
      { kind: "composition", count: 5, age: { ageMode: "approx", age: 45 }, traits: {} },
      2,
      TODAY,
    );
    expect(row).toMatchObject({ kind: "composition", count: 5, position: 2, age_mode: "approx", age: 45, age_as_of: TODAY, name: null, is_self: false });
  });

  it("keeps the old age_as_of when the stated age is unchanged, resets it when changed", () => {
    const entry = { kind: "composition", count: 1, age: { ageMode: "exact", age: 3 }, traits: {} } as const;
    const existing = { age_mode: "exact", age: 3, age_as_of: "2025-01-01" } as const;
    expect(entryToRow(entry, 0, TODAY, existing).age_as_of).toBe("2025-01-01");
    expect(entryToRow({ ...entry, age: { ageMode: "exact", age: 4 } }, 0, TODAY, existing).age_as_of).toBe(TODAY);
  });

  it("stores no age data for relativeToMe, birthdate members or self", () => {
    expect(entryToRow({ kind: "composition", count: 2, age: { ageMode: "relativeToMe" }, traits: {} }, 0, TODAY)).toMatchObject({ age_mode: "relativeToMe", age: null, age_as_of: null });
    expect(entryToRow({ kind: "member", isSelf: false, name: "Ben", birthdate: "2015-01-01", traits: {} }, 0, TODAY)).toMatchObject({ birthdate: "2015-01-01", age_mode: null, age: null, age_as_of: null, count: 1 });
    expect(entryToRow({ kind: "member", isSelf: true, traits: {} }, 0, TODAY)).toMatchObject({ is_self: true, name: null });
  });
});

describe("rowToEntry", () => {
  const row: GroupEntryRow = {
    id: "11111111-1111-4111-8111-111111111111",
    group_id: "22222222-2222-4222-8222-222222222222",
    kind: "composition",
    position: 1,
    count: 2,
    label: "Eltern",
    name: null,
    is_self: false,
    birthdate: null,
    age_mode: "relativeToMe",
    age: null,
    age_as_of: null,
    notes: null,
    traits: { needsNap: true },
  };
  it("maps a composition row", () => {
    expect(rowToEntry(row)).toEqual({
      id: row.id,
      position: 1,
      kind: "composition",
      count: 2,
      label: "Eltern",
      notes: undefined,
      traits: { needsNap: true },
      age: { ageMode: "relativeToMe" },
      ageAsOf: undefined,
    });
  });
  it("maps a member with stated age and tolerates broken traits", () => {
    const entry = rowToEntry({ ...row, kind: "member", count: 1, name: "Ben", age_mode: "approx", age: 4, age_as_of: "2026-01-01", traits: { bogus: 1 } });
    expect(entry).toMatchObject({ kind: "member", name: "Ben", isSelf: false, age: { ageMode: "approx", age: 4 }, ageAsOf: "2026-01-01", traits: {} });
  });
});
