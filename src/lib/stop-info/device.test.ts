import { describe, expect, it } from "vitest";
import { isIOS, requestPlaybackAudio, silentWav, silentWavDataUrl } from "./device";

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

describe("silentWav", () => {
  it("is a valid PCM WAV header followed by silence", () => {
    const wav = silentWav(10);
    const text = (from: number, to: number) => String.fromCharCode(...wav.slice(from, to));
    const view = new DataView(wav.buffer);
    expect(wav.length).toBe(54);
    expect([text(0, 4), text(8, 12), text(12, 16), text(36, 40)]).toEqual(["RIFF", "WAVE", "fmt ", "data"]);
    expect(view.getUint32(4, true)).toBe(46);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(8000);
    expect(view.getUint32(40, true)).toBe(10);
    expect([...wav.slice(44)].every((b) => b === 128)).toBe(true);
  });
});

describe("silentWavDataUrl", () => {
  it("encodes the silent WAV as a data URL", () => {
    const url = silentWavDataUrl();
    expect(url.startsWith("data:audio/wav;base64,")).toBe(true);
    const bytes = Uint8Array.from(atob(url.split(",")[1]), (c) => c.charCodeAt(0));
    expect(bytes).toEqual(silentWav());
  });
});
