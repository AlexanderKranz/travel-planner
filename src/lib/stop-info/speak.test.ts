import { describe, expect, it } from "vitest";
import { chunks, hasVoice, speakable, stopSpeech } from "./speak";

describe("read-out text (spec 6)", () => {
  it("drops parenthesised asides (pronunciation, IPA) before speaking", () => {
    expect(speakable("Der Stephansdom (Domkirche St. Stephan (Wien)) ist eine Kirche.")).toBe("Der Stephansdom ist eine Kirche.");
  });

  it("drops IPA in square brackets", () => {
    expect(speakable("Der Hyde Park [ˌhaɪdˈpɑːk] ist eine öffentliche Grünanlage.")).toBe("Der Hyde Park ist eine öffentliche Grünanlage.");
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
    expect(stopSpeech({ ...base, textVoice: false })).toEqual([{ text: "1. Dom.", lang: "de" }, { text: "Erbaut 1147", lang: "de" }]);
  });

  it("reads a text in the intro's language even when no voice for it is listed (Safari on macOS)", () => {
    const parts = stopSpeech({ intro: "1. Hyde Park.", introLang: "de", text: "Der Hyde Park ist ein Park.", textLang: "de-DE", facts: [], textVoice: false });
    expect(parts).toEqual([
      { text: "1. Hyde Park.", lang: "de" },
      { text: "Der Hyde Park ist ein Park.", lang: "de-DE" },
    ]);
  });
});

describe("hasVoice", () => {
  it("accepts de-DE and de_DE, and reads anyway while the voice list is unknown (empty)", () => {
    expect(hasVoice(["de-de", "en-gb"], "de")).toBe(true);
    expect(hasVoice(["de_DE"], "de")).toBe(true);
    expect(hasVoice(["en-US"], "en")).toBe(true);
    expect(hasVoice([], "de")).toBe(true);
    expect(hasVoice(["fr-fr", "it-it"], "de")).toBe(false);
    expect(hasVoice(["de-at"], "en")).toBe(false);
  });
});
