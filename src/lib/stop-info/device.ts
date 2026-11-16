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
