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
