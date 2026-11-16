import { describe, expect, it } from "vitest";
import { isIOS, requestPlaybackAudio } from "./device";

describe("isIOS", () => {
  it("detects iPhone and iPad user agents", () => {
    expect(isIOS({ userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15" })).toBe(true);
    expect(isIOS({ userAgent: "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)" })).toBe(true);
  });

  it("treats a touch 'Mac' as iPadOS, a real Mac and Android not", () => {
    const mac = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15";
    expect(isIOS({ userAgent: mac, platform: "MacIntel", maxTouchPoints: 5 })).toBe(true);
    expect(isIOS({ userAgent: mac, platform: "MacIntel", maxTouchPoints: 0 })).toBe(false);
    expect(isIOS({ userAgent: "Mozilla/5.0 (Linux; Android 14; Pixel 8)", platform: "Linux armv8l", maxTouchPoints: 5 })).toBe(false);
  });
});

describe("requestPlaybackAudio", () => {
  it("sets the audio session to playback when the API exists", () => {
    const nav = { audioSession: { type: "auto" } };
    expect(requestPlaybackAudio(nav)).toBe(true);
    expect(nav.audioSession.type).toBe("playback");
  });

  it("does nothing without the API or when setting throws", () => {
    expect(requestPlaybackAudio({})).toBe(false);
    expect(requestPlaybackAudio(undefined)).toBe(false);
    const throwing = {
      audioSession: {
        get type() {
          return "auto";
        },
        set type(_v: string) {
          throw new Error("not allowed");
        },
      },
    };
    expect(requestPlaybackAudio(throwing)).toBe(false);
  });
});
