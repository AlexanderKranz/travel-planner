/** FNV-1a 32-bit hex (8 chars) of text.trim().toLowerCase(). Isomorphic, no crypto: a stable key, not a secret. */
export function openItemKey(text: string): string {
  const s = text.trim().toLowerCase();
  let h = 0x811c9dc5;
  for (const byte of new TextEncoder().encode(s)) {
    h ^= byte;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}
