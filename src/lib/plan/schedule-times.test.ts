import { describe, expect, it } from "vitest";
import type { PlanActivity } from "@/lib/domain/plan";
import { noteTimes } from "./assemble";
import { guardScheduleTimes, notesNamePlace } from "./schedule-times";

const NOTES = "Schiff, feste Hafenzeiten:\n2037-12-19 Passau ab 16:00\n2037-12-21 Melk an 15:00 ab 21:00\n2037-12-23 Passau an morgens";
const times = noteTimes(NOTES);
const guard = (acts: PlanActivity[], place = "Passau", notes: string | undefined = NOTES) => guardScheduleTimes(acts, place, notes, times);

describe("notesNamePlace", () => {
  it("matches the stop's name part as a whole word, ignoring case and accents", () => {
    expect(notesNamePlace(NOTES, "Passau")).toBe(true);
    expect(notesNamePlace(NOTES, "Passau: Ausschiffung")).toBe(true);
    expect(notesNamePlace(NOTES, "melk (Stift)")).toBe(true);
    expect(notesNamePlace("Wien an 14:00", "Wièn")).toBe(true);
    expect(notesNamePlace(NOTES, "An Bord")).toBe(false);
    expect(notesNamePlace(NOTES, "Pass")).toBe(false);
    expect(notesNamePlace(undefined, "Passau")).toBe(false);
  });
});

describe("guardScheduleTimes (issue #142)", () => {
  it("drops an invented arrival time at a place the notes name ('an morgens' → no 09:00)", () => {
    const r = guard([
      { at: "09:00", kind: "travel", text: "Ankunft, Ausschiffen, Gepäck" },
      { at: "10:30", until: "11:45", kind: "do", text: "Spielen mit Kleinkind" },
    ]);
    expect(r.dropped).toBe(1);
    expect(r.acts).toEqual([
      { kind: "travel", text: "Ankunft, Ausschiffen, Gepäck" },
      { at: "10:30", until: "11:45", kind: "do", text: "Spielen mit Kleinkind" },
    ]);
  });

  it("keeps times that are in the notes, the travellers' own travel, and other kinds", () => {
    const acts: PlanActivity[] = [
      { at: "16:00", kind: "travel", text: "Abfahrt des Schiffs" },
      { at: "09:30", kind: "travel", text: "Anreise, Gepäck, Einchecken an Bord" },
      { at: "13:00", kind: "food", text: "Mittagessen nach der Ankunft" },
    ];
    expect(guard(acts)).toEqual({ acts, dropped: 0 });
  });

  it("drops only an invented end when the start is in the notes", () => {
    expect(guard([{ at: "15:00", until: "15:30", kind: "travel", text: "Anlegen in Melk" }], "Melk").acts).toEqual([
      { at: "15:00", kind: "travel", text: "Anlegen in Melk" },
    ]);
  });

  it("does nothing at a place the notes do not name, or without notes", () => {
    const acts: PlanActivity[] = [{ at: "09:00", kind: "travel", text: "Arrival and transfer" }];
    expect(guard(acts, "Marbella").dropped).toBe(0);
    expect(guardScheduleTimes(acts, "Passau", undefined, times).dropped).toBe(0);
  });
});
