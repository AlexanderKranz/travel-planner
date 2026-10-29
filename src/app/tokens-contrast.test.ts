import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { contrast } from "@/lib/contrast";

/**
 * WCAG contrast of the Atlas token pairs that components actually combine (see src/components/ui/styles.ts and the
 * components that use text-*, bg-* utilities). Text pairs need 4.5:1, UI boundaries and focus rings 3:1.
 * Reads src/app/globals.css, so a token edit that breaks a pair fails here.
 */
const css = readFileSync(resolve(__dirname, "globals.css"), "utf8");

function tokens(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1]] = m[2];
  return out;
}
const lightBlock = /:root\s*\{([\s\S]*?)\n\}/.exec(css)![1];
const darkBlock = /prefers-color-scheme:\s*dark\)\s*\{\s*:root\s*\{([\s\S]*?)\n\s*\}\s*\n\}/.exec(css)![1];
const light = tokens(lightBlock);
const dark = { ...light, ...tokens(darkBlock) };
const WHITE = "#ffffff";

/** [foreground, background, where it is used] */
const TEXT: [string, string, string][] = [
  ["ink", "page", "body text"],
  ["ink", "card", "card text"],
  ["ink", "sunken", "tiles, tags"],
  ["muted", "page", "secondary text"],
  ["muted", "card", "secondary text in cards"],
  ["muted", "sunken", "secondary text in tiles"],
  ["subtle", "page", "labels"],
  ["subtle", "card", "labels, placeholders"],
  ["subtle", "sunken", "tile captions"],
  ["heading", "page", "headings, links"],
  ["heading", "card", "headings in cards"],
  ["heading", "hover", "secondary button hover"],
  ["accent-text", "page", "eyebrows, link hover"],
  ["accent-text", "card", "eyebrows in cards"],
  ["page", "heading", "solid pill"],
  ["header-fg", "header", "app header"],
  ["header-muted", "header", "header secondary"],
  ["feature-fg", "feature", "best-day card"],
  ["feature-muted", "feature", "best-day card secondary"],
  ["feature-accent", "feature", "best-day card accent"],
  ["accent-soft-fg", "accent-soft", "accent pill"],
  ["info-fg", "info-bg", "info box"],
  ["warn-fg", "warn-bg", "warning box, demo banner"],
  ["danger-fg", "danger-bg", "error box"],
  ["danger", "page", "inline error text"],
  ["danger", "card", "inline error text in cards"],
  ["danger", "sunken", "inline error text in tiles"],
  ["ok-fg", "ok-bg", "success box"],
  ["ok", "card", "success text"],
  ["sport", "card", "sport tag text"],
];
/** White text on solid fills (buttons). */
const ON_WHITE: [string, string][] = [
  ["accent", "primary button"],
  ["accent-hover", "primary button hover"],
  ["danger-solid", "danger button"],
  ["danger-hover", "danger button hover"],
  ["ok-solid", "success fill"],
];
const NON_TEXT: [string, string, string][] = [
  ["line-strong", "card", "input border"],
  ["line-strong", "page", "input border on page"],
  ["focus", "page", "focus ring"],
  ["focus", "card", "focus ring in cards"],
];

for (const [name, t] of [["light", light], ["dark", dark]] as const) {
  describe(`Atlas contrast (${name})`, () => {
    it.each(TEXT)("%s on %s (%s) >= 4.5", (fg, bg) => {
      expect(contrast(t[fg], t[bg]), `${fg} ${t[fg]} on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
    });
    it.each(ON_WHITE)("white on %s (%s) >= 4.5", (bg) => {
      expect(contrast(WHITE, t[bg]), `white on ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(4.5);
    });
    it.each(NON_TEXT)("%s against %s (%s) >= 3", (fg, bg) => {
      expect(contrast(t[fg], t[bg]), `${fg} ${t[fg]} vs ${bg} ${t[bg]}`).toBeGreaterThanOrEqual(3);
    });
  });
}
