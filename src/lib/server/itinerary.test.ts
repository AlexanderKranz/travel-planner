import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const h = vi.hoisted(() => ({
  session: { userId: "actor" } as Record<string, unknown> | null,
  row: null as Record<string, unknown> | null,
  run: vi.fn(),
  derive: vi.fn(),
  event: vi.fn(),
}));
vi.mock("./session", () => ({ getUserSession: async () => h.session }));
vi.mock("./events", () => ({ logEvent: h.event }));
vi.mock("./itinerary-ai", async (orig) => ({ ...(await orig<typeof import("./itinerary-ai")>()), runItineraryAi: h.run }));
vi.mock("./itinerary-notes", () => ({ deriveNotesStops: h.derive }));
vi.mock("./settings", () => ({ getEffectiveEnv: async () => ({}) }));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => ({}) }));

import { derivedTripStops, extractItinerary } from "./itinerary";

const TRIP_ID = "00000000-0000-4000-8000-000000000001";
const ctx = { startDate: "2037-12-19", lengthDays: 5 };
const supabase = {
  from: () => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.eq = () => q;
    q.maybeSingle = async () => ({ data: h.row, error: null });
    return q;
  },
};
const PROSE = `Am 19.12. legen wir am späten Nachmittag gegen 16 Uhr in Passau ab
Am 20.12. erreichen wir nach einer ruhigen Nacht um 14 Uhr die Hauptstadt Wien`;
const TABLE = "Datum Hafen Ankunft Abfahrt\n19.12.2037 Passau – 16:00\n20.12.2037 Wien 14:00 23:59";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]).toString("base64");
const extract = { stops: [{ date: "--12-19", place: "Passau", dep: "16:00" }, { date: "--12-20", place: "Wien", arr: "14:00" }], drops: { notInSource: 0, noPlace: 0, invalid: 0 } };

beforeEach(() => {
  h.session = { userId: "actor", supabase };
  h.row = { owner_id: "owner", trip_shares: [{ grantee_id: "actor", access: "write" }] };
  h.run.mockReset().mockResolvedValue({ ok: true, extract, cached: false });
  h.derive.mockReset();
  h.event.mockReset();
});

describe("extractItinerary", () => {
  it("text: a parser hit on the server costs no call", async () => {
    const r = await extractItinerary(TRIP_ID, { kind: "text", text: TABLE }, ctx);
    expect(r).toMatchObject({ ok: true, path: "parser" });
    expect(h.run).not.toHaveBeenCalled();
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ event: "itinerary.extracted", props: { path: "parser", source: "upload", stops: 2, flagged: 0, pages: 0 } }));
  });

  it("text: a parser miss goes to Haiku with the PREFILTERED text, cached under the trip owner", async () => {
    const r = await extractItinerary(TRIP_ID, { kind: "text", text: "Erika Mustermann\nBuchung XX-000000\n" + PROSE }, ctx);
    expect(r).toEqual({
      ok: true,
      path: "text_ai",
      stops: [
        { stop: { day: 1, place: "Passau", dep: "16:00" }, date: "2037-12-19", flags: ["year_guessed"] },
        { stop: { day: 2, place: "Wien", arr: "14:00" }, date: "2037-12-20", flags: ["year_guessed"] },
      ],
    });
    expect(h.run).toHaveBeenCalledWith(h.session, "owner", { kind: "text", text: PROSE });
  });

  it("images: checks the bytes and sends them; pages = image count", async () => {
    const r = await extractItinerary(null, { kind: "images", images: [{ mediaType: "image/jpeg", data: JPEG }] }, ctx);
    expect(r).toMatchObject({ ok: true, path: "image_ai" });
    expect(h.run).toHaveBeenCalledWith(h.session, "actor", { kind: "images", images: [{ mediaType: "image/jpeg", data: JPEG }] });
    expect(h.event).toHaveBeenCalledWith(expect.objectContaining({ props: expect.objectContaining({ path: "image_ai", pages: 1 }) }));
  });

  it("refuses images whose bytes are not the declared type", async () => {
    const pdf = Buffer.from("%PDF-1.7 synthetic").toString("base64");
    expect(await extractItinerary(null, { kind: "images", images: [{ mediaType: "image/jpeg", data: pdf }] }, ctx)).toEqual({ ok: false, error: "invalid" });
    expect(h.run).not.toHaveBeenCalled();
  });

  it("needs write access to the trip: read grantee, unknown trip and signed-out users are forbidden", async () => {
    h.row = { owner_id: "owner", trip_shares: [{ grantee_id: "actor", access: "read" }] };
    expect(await extractItinerary(TRIP_ID, { kind: "text", text: PROSE }, ctx)).toEqual({ ok: false, error: "forbidden" });
    h.row = null;
    expect(await extractItinerary(TRIP_ID, { kind: "text", text: PROSE }, ctx)).toEqual({ ok: false, error: "forbidden" });
    h.session = null;
    expect(await extractItinerary(null, { kind: "text", text: PROSE }, ctx)).toEqual({ ok: false, error: "forbidden" });
    expect(h.run).not.toHaveBeenCalled();
  });

  it("validates input and context", async () => {
    expect(await extractItinerary("nope", { kind: "text", text: PROSE }, ctx)).toEqual({ ok: false, error: "invalid" });
    expect(await extractItinerary(null, { kind: "text", text: "" }, ctx)).toEqual({ ok: false, error: "invalid" });
    expect(await extractItinerary(null, { kind: "text", text: PROSE }, { startDate: "19.12.2037", lengthDays: 5 })).toEqual({ ok: false, error: "invalid" });
  });

  it("no_stops when nothing itinerary-like survives the prefilter, or Haiku finds nothing", async () => {
    expect(await extractItinerary(null, { kind: "text", text: "Packliste\nWarme Jacke\nMütze" }, ctx)).toEqual({ ok: false, error: "no_stops" });
    h.run.mockResolvedValue({ ok: true, extract: { stops: [], drops: { notInSource: 0, noPlace: 0, invalid: 0 } }, cached: false });
    expect(await extractItinerary(null, { kind: "text", text: PROSE }, ctx)).toEqual({ ok: false, error: "no_stops" });
  });

  it("passes gate errors through (ai_off, demo, rate_limited, budget, failed)", async () => {
    for (const error of ["ai_off", "demo", "rate_limited", "budget", "failed"]) {
      h.run.mockResolvedValueOnce({ ok: false, error });
      expect(await extractItinerary(null, { kind: "text", text: PROSE }, ctx)).toEqual({ ok: false, error });
    }
  });
});

describe("derivedTripStops", () => {
  const tripRow = (extra: Record<string, unknown> = {}) => ({
    id: TRIP_ID, owner_id: "owner", title: null, dest_kind: "freetext", dest_name: "Donau", length_days: 5, start_date: "2037-12-19", months: null,
    group_id: null, purpose_id: null, wants_flights: false, origin_airports: [], notes: PROSE, stops: null, created_at: "x", updated_at: "x",
    trip_shares: [{ grantee_id: "actor", access: "write" }], ...extra,
  });

  it("derives from the notes; AI allowed for a write grantee", async () => {
    h.row = tripRow();
    h.derive.mockResolvedValue({ notes: PROSE, stops: [{ day: 1, place: "Passau" }, { day: 2, place: "Wien" }] });
    expect(await derivedTripStops(TRIP_ID)).toEqual([{ day: 1, place: "Passau" }, { day: 2, place: "Wien" }]);
    expect(h.derive).toHaveBeenCalledWith(expect.objectContaining({ id: TRIP_ID, notes: PROSE }), { session: h.session, allowAi: true });
  });

  it("read grantee: parser and cache only", async () => {
    h.row = tripRow({ trip_shares: [{ grantee_id: "actor", access: "read" }] });
    h.derive.mockResolvedValue(null);
    expect(await derivedTripStops(TRIP_ID)).toEqual([]);
    expect(h.derive).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ allowAi: false }));
  });

  it("empty with confirmed stops, without notes, for an unknown trip or a bad id", async () => {
    h.row = tripRow({ stops: [{ day: 1, place: "Passau" }] });
    expect(await derivedTripStops(TRIP_ID)).toEqual([]);
    h.row = tripRow({ notes: null });
    expect(await derivedTripStops(TRIP_ID)).toEqual([]);
    h.row = null;
    expect(await derivedTripStops(TRIP_ID)).toEqual([]);
    expect(await derivedTripStops("nope")).toEqual([]);
    expect(h.derive).not.toHaveBeenCalled();
  });
});
