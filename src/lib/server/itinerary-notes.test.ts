import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({ cached: null as unknown, event: vi.fn(), find: vi.fn() }));
vi.mock("./events", () => ({ logEvent: h.event }));
vi.mock("./itinerary-ai", () => ({ findExtract: h.find, runItineraryAi: vi.fn() }));

import type { Trip } from "@/lib/domain/trip";
import { deriveNotesStops, notesDeriver } from "./itinerary-notes";

const session = { userId: "actor", supabase: {} } as never;
const trip = (notes: string, extra: Partial<Trip> = {}): Trip =>
  ({ id: "t1", ownerId: "owner", access: "owner", lengthDays: 5, timing: { kind: "date", startDate: "2037-12-19" }, notes, ...extra }) as Trip;

const NOTES = `Schiff, feste Hafenzeiten:
2037-12-19 Passau ab 16:00
2037-12-20 Wien an 14:00 ab 23:59
2037-12-24 Regensburg an 09:00`;
// A parser miss: prose lines (still at least 2 kept lines).
const PROSE = `Am 19.12. legen wir am späten Nachmittag gegen 16 Uhr in Passau ab
Am 20.12. erreichen wir nach einer ruhigen Nacht um 14 Uhr die Hauptstadt Wien`;
const aiStops = { stops: [{ date: "--12-19", place: "Passau", dep: "16:00" }, { date: "--12-20", place: "Wien", arr: "14:00" }], drops: { notInSource: 0, noPlace: 0, invalid: 0 } };

beforeEach(() => {
  h.event.mockReset();
  h.find.mockReset().mockResolvedValue(null);
});

describe("deriveNotesStops [D10]", () => {
  it("parser path: 0 tokens, stops outside the trip dropped, no cache lookup", async () => {
    const run = vi.fn();
    const got = await deriveNotesStops(trip(NOTES), { session, allowAi: true, run, today: "2026-11-11" });
    expect(got).toEqual({ notes: NOTES, stops: [{ day: 1, place: "Passau", dep: "16:00" }, { day: 2, place: "Wien", arr: "14:00", dep: "23:59" }] });
    expect(run).not.toHaveBeenCalled();
    expect(h.find).not.toHaveBeenCalled();
  });

  it("parser miss: Haiku text path on the prefiltered notes, cached under the trip OWNER, event without content", async () => {
    const run = vi.fn(async () => ({ ok: true, extract: aiStops, cached: false })) as never;
    const got = await deriveNotesStops(trip(PROSE), { session, allowAi: true, run, today: "2026-11-11" });
    expect(got?.stops).toEqual([{ day: 1, place: "Passau", dep: "16:00" }, { day: 2, place: "Wien", arr: "14:00" }]);
    expect(run).toHaveBeenCalledWith(session, "owner", { kind: "text", text: PROSE });
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ event: "itinerary.extracted", props: expect.objectContaining({ path: "text_ai", source: "notes", stops: 2 }) }));
    expect(JSON.stringify(h.event.mock.calls)).not.toContain("Passau");
  });

  it("uses the owner's cache without a session (background work), never calls Haiku then", async () => {
    h.find.mockResolvedValue(aiStops);
    const got = await deriveNotesStops(trip(PROSE), { session: null, allowAi: false, today: "2026-11-11" });
    expect(got?.stops).toHaveLength(2);
    expect(h.find).toHaveBeenCalledWith("owner", expect.stringMatching(/^[0-9a-f]{64}$/));
  });

  it("returns null when AI is not allowed, refused, gives fewer than 2 stops, or the notes are a single line", async () => {
    const run = vi.fn(async () => ({ ok: false, error: "rate_limited" })) as never;
    expect(await deriveNotesStops(trip(PROSE), { session, allowAi: false, run })).toBeNull();
    expect(run).not.toHaveBeenCalled();
    expect(await deriveNotesStops(trip(PROSE), { session, allowAi: true, run })).toBeNull();
    const one = vi.fn(async () => ({ ok: true, extract: { ...aiStops, stops: aiStops.stops.slice(0, 1) }, cached: false })) as never;
    expect(await deriveNotesStops(trip(PROSE), { session, allowAi: true, run: one })).toBeNull();
    const single = vi.fn();
    expect(await deriveNotesStops(trip("Wir legen am 19.12. um 16 Uhr in Passau ab und freuen uns"), { session, allowAi: true, run: single })).toBeNull();
    expect(single).not.toHaveBeenCalled();
    expect(await deriveNotesStops(trip(""), { session, allowAi: true, run: single })).toBeNull();
  });

  it("never throws", async () => {
    const run = vi.fn(async () => {
      throw new Error("boom");
    }) as never;
    expect(await deriveNotesStops(trip(PROSE), { session, allowAi: true, run })).toBeNull();
  });

  it("notesDeriver allows AI only for a session that can edit the trip", async () => {
    // Read grantee: parser and cache only (the AI path would need runItineraryAi, which is a bare mock here).
    h.find.mockResolvedValue(null);
    expect(await notesDeriver(session)(trip(PROSE, { access: "read" }))).toBeNull();
    expect(await notesDeriver(null)(trip(NOTES))).toMatchObject({ notes: NOTES });
  });
});
