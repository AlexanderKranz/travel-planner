import { describe, expect, it } from "vitest";
import { chunks, speakable, stopSpeech } from "./speak";

describe("read-out text (spec 6)", () => {
  it("drops parenthesised asides (pronunciation, IPA) before speaking", () => {
    expect(speakable("Der Stephansdom (Domkirche St. Stephan (Wien)) ist eine Kirche.")).toBe("Der Stephansdom ist eine Kirche.");
  });

  it("splits into sentence chunks of at most ~220 characters", () => {
    const text = Array.from({ length: 12 }, (_, i) => `Das ist der Satz Nummer ${i} über einen Ort.`).join(" ");
    const c = chunks(text);
    expect(c.length).toBeGreaterThan(1);
    expect(c.every((x) => x.length <= 220)).toBe(true);
    expect(c.join(" ")).toBe(speakable(text));
    expect(chunks("x".repeat(500)).every((x) => x.length <= 220)).toBe(true);
  });

  it("intro and facts in the owner's language, the text in its own; no voice for it → text skipped", () => {
    const base = { intro: "1. Dom.", introLang: "de", text: "St. Stephen's is a church.", textLang: "en", facts: ["Erbaut 1147"] };
    expect(stopSpeech({ ...base, textVoice: true })).toEqual([
      { text: "1. Dom.", lang: "de" },
      { text: "St. Stephen's is a church.", lang: "en" },
      { text: "Erbaut 1147", lang: "de" },
    ]);
    expect(stopSpeech({ ...base, textVoice: false }).map((p) => p.lang)).toEqual(["de", "de"]);
  });
});
