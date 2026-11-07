import { describe, expect, it } from "vitest";
import { withoutLinkedUserIds, type TravelGroup } from "./group";

describe("withoutLinkedUserIds", () => {
  it("drops account ids from every entry and keeps the display link and myEntryId", () => {
    const g = {
      id: "g",
      myEntryId: "e1",
      entries: [{ id: "e1", kind: "member", linkedUserId: "00000000-0000-4000-8000-000000000001", link: { kind: "me" } }],
    } as unknown as TravelGroup;
    const out = withoutLinkedUserIds(g);
    expect(JSON.stringify(out)).not.toContain("0000-4000");
    expect(out.entries[0].link).toEqual({ kind: "me" });
    expect(out.myEntryId).toBe("e1");
    expect(g.entries[0].linkedUserId).toBeDefined(); // the input is untouched
  });
});
