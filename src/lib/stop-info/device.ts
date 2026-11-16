/**
 * Device checks for the read-out (docs/specs/city-tour-stop-info.md section 6). Pure: the UI passes `navigator` values.
 */

/**
 * iPhone, iPad or iPod. iPadOS reports itself as a Mac ("MacIntel"), so a Mac with a touch screen counts as an iPad
 * (real Macs report 0 touch points).
 */
export function isIOS(p: { userAgent: string; platform?: string; maxTouchPoints?: number }): boolean {
  if (/iPhone|iPad|iPod/.test(p.userAgent)) return true;
  return p.platform === "MacIntel" && (p.maxTouchPoints ?? 0) > 1;
}

type AudioSessionNavigator = { audioSession?: { type: string } };

/**
 * Ask the browser to treat the page's audio as media playback (Audio Session API, Safari 17+), so that on iOS the
 * ring/silent switch may not mute the read-out. Browsers without the API ignore it. Returns whether it was set.
 */
export function requestPlaybackAudio(nav: AudioSessionNavigator | undefined): boolean {
  const session = nav?.audioSession;
  if (!session) return false;
  try {
    if (session.type !== "playback") session.type = "playback";
    return true;
  } catch {
    return false;
  }
}

/**
 * A short silent WAV (8 kHz, 8-bit mono; 128 is silence for 8-bit PCM). On iOS, an audio element playing this in a
 * loop while reading puts the page into media playback, which may let Web Speech sound despite the silent switch.
 * Built in code, so no asset file is needed.
 */
export function silentWav(samples = 800): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(44 + samples);
  const view = new DataView(out.buffer);
  const ascii = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  ascii(0, "RIFF");
  view.setUint32(4, 36 + samples, true);
  ascii(8, "WAVE");
  ascii(12, "fmt ");
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, 8000, true); // sample rate
  view.setUint32(28, 8000, true); // byte rate
  view.setUint16(32, 1, true); // block align
  view.setUint16(34, 8, true); // bits per sample
  ascii(36, "data");
  view.setUint32(40, samples, true);
  out.fill(128, 44);
  return out;
}

/** `silentWav()` as a `data:` URL (about 1 KB). */
export function silentWavDataUrl(): string {
  return `data:audio/wav;base64,${btoa(String.fromCharCode(...silentWav()))}`;
}
