// Atlas palette for the PDF. Mirrors the light tokens in src/app/globals.css (the PDF has no dark mode).
export const C = {
  page: "#f6f1e7",
  card: "#ffffff",
  sunken: "#efe7d6",
  ink: "#1c2430",
  muted: "#4a5562",
  subtle: "#6b7480",
  line: "#ddd2bf",
  navy: "#1f3a5f",
  navyMuted: "#cfd8e3",
  accent: "#b4532a",
  accentLight: "#f2a679",
  accentSoft: "#f3dccd",
  accentSoftFg: "#8a3a17",
  warnBg: "#fbeee3",
  warnFg: "#7a3412",
  okBg: "#e5f0e9",
  okFg: "#1f4d37",
  okLine: "#2f6b4f",
  okLight: "#a8d5bd",
  infoBg: "#e9eef5",
  infoFg: "#1f3a5f",
  infoLine: "#8fa5c0",
  cream: "#f6f1e7",
} as const;

/** Font stacks: the first family with the glyph wins (Noto Sans only fills non-Latin gaps). */
export const SANS = ["Inter", "NotoSans"];
export const SERIF = ["Fraunces", "Inter", "NotoSans"];
