import { describe, expect, it } from "vitest";
import { DISTANCE_TEXT, stripDistances } from "./distance-text";

describe("stripDistances (issue #142)", () => {
  it.each([
    ["Rudervereine liegen etwa 15 km entfernt, daher Escape Room.", "Rudervereine liegen weiter entfernt, daher Escape Room."],
    ["Etwa 15 km entfernt liegt der Zoo.", "Weiter entfernt liegt der Zoo."],
    ["The rowing club is about 2.5 km away.", "The rowing club is further away."],
    ["Ruderverein (15 km) vorher anfragen", "Ruderverein vorher anfragen"],
    ["Eine 5-km-Runde am Fluss", "Eine Runde am Fluss"],
    ["Liegt 2 km außerhalb der Altstadt", "Liegt außerhalb der Altstadt"],
    ["Nur 500 m vom Hafen", "vom Hafen"],
    ["Walk 3 miles along the river", "Walk along the river"],
    ["Ca. 1,5 Kilometer bis zum Markt", "bis zum Markt"],
    // Ranges and a glued "ca." go as a whole (CodeRabbit on #143).
    ["Ein 10-15 km Radweg am Main", "Ein Radweg am Main"],
    ["Der Weg ist 2 bis 3 km lang", "Der Weg ist lang"],
    ["Der Zoo liegt zwischen 2 und 3 km vom Hafen", "Der Zoo liegt vom Hafen"],
    ["Rudervereine ca.15 km entfernt", "Rudervereine weiter entfernt"],
    ["A loop of 2–3 miles", "A loop of"],
    ["between 2 and 3 km away", "further away"],
  ])("%s", (input, out) => {
    expect(stripDistances(input)).toEqual({ text: out, hit: true });
  });

  it.each(["Tempo 50 km/h auf der Uferstraße", "15 min zu Fuß", "18 Loch, flach", "2 Minuten", "Mittagsschlaf an Bord", "Par 72", "Kinderbecken 2m²"])(
    "leaves %s alone",
    (s) => {
      expect(stripDistances(s)).toEqual({ text: s, hit: false });
      expect(DISTANCE_TEXT.test(s)).toBe(false);
    },
  );
});
