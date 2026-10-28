import path from "node:path";
import { Font } from "@react-pdf/renderer";

let registered = false;

/** Registers Noto Sans (OFL) once. Built-in Helvetica lacks the arrow and approx glyphs used in plan titles. */
export function registerFonts(): void {
  if (registered) return;
  const dir = path.join(process.cwd(), "src/assets/fonts");
  Font.register({
    family: "NotoSans",
    fonts: [
      { src: path.join(dir, "NotoSans-Regular.ttf") },
      { src: path.join(dir, "NotoSans-Bold.ttf"), fontWeight: 700 },
    ],
  });
  Font.registerHyphenationCallback((w) => [w]);
  registered = true;
}
