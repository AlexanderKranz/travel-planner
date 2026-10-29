import path from "node:path";
import { Font } from "@react-pdf/renderer";

let registered = false;

/**
 * Registers Inter (UI/body), Fraunces (display) and Noto Sans (glyph fallback for non-Latin place names), all OFL.
 * Inter/Fraunces are static, Latin-subset instances of the Google variable fonts with the ligature features
 * (liga/clig/dlig/hlig) removed, so "fl"/"ff" stay two glyphs and copied text is complete.
 * Licences: src/assets/fonts/OFL-*.txt.
 */
export function registerFonts(): void {
  if (registered) return;
  const dir = path.join(process.cwd(), "src/assets/fonts");
  const f = (name: string) => path.join(dir, name);
  Font.register({
    family: "Inter",
    fonts: [
      { src: f("Inter-Regular.ttf") },
      { src: f("Inter-SemiBold.ttf"), fontWeight: 600 },
      { src: f("Inter-Bold.ttf"), fontWeight: 700 },
    ],
  });
  Font.register({
    family: "Fraunces",
    fonts: [{ src: f("Fraunces-Regular.ttf") }, { src: f("Fraunces-Bold.ttf"), fontWeight: 700 }],
  });
  Font.register({
    family: "NotoSans",
    fonts: [{ src: f("NotoSans-Regular.ttf") }, { src: f("NotoSans-Bold.ttf"), fontWeight: 700 }],
  });
  Font.registerHyphenationCallback((w) => [w]);
  registered = true;
}
