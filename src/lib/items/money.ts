const MAX_CENTS = 100_000_000;

/**
 * "432,64" / "1.234,56" (de) / "1,234.56" (en) / "459" -> cents; empty -> null; unparseable -> "invalid".
 * A lone separator followed by exactly 3 digits is a thousands separator only if it is the locale's group separator.
 */
export function parseMoney(input: string, locale: string): number | null | "invalid" {
  const s = input.replace(/[^\d.,\-+]/g, ""); // drops spaces (also NBSP / thin space) and currency symbols
  if (input.trim() === "") return null;
  if (!/\d/.test(s)) return "invalid";
  if (!/^\d[\d.,]*$/.test(s)) return "invalid"; // sign or leading separator
  const decimalSep = locale.toLowerCase().startsWith("de") ? "," : ".";
  const groupSep = decimalSep === "," ? "." : ",";

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let intPart: string;
  let frac = "";
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? "." : ",";
    const grp = dec === "." ? "," : ".";
    const idx = s.lastIndexOf(dec);
    intPart = s.slice(0, idx);
    frac = s.slice(idx + 1);
    if (intPart.includes(dec) || !isGrouped(intPart, grp)) return "invalid";
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const count = s.split(sep).length - 1;
    const idx = s.lastIndexOf(sep);
    const after = s.slice(idx + 1);
    if (count > 1) {
      if (!isGrouped(s, sep)) return "invalid";
      intPart = s;
    } else if (after.length === 3 && sep === groupSep && /^\d{1,3}$/.test(s.slice(0, idx))) {
      intPart = s;
    } else if (after.length <= 2) {
      intPart = s.slice(0, idx);
      frac = after;
    } else {
      return "invalid";
    }
    if (count > 1 || (after.length === 3 && sep === groupSep && frac === "")) {
      // pure thousands grouping
      intPart = intPart.split(sep).join("");
    }
  } else {
    intPart = s;
  }
  intPart = intPart.replace(/[.,]/g, "");
  if (!/^\d+$/.test(intPart) || !/^\d{0,2}$/.test(frac)) return "invalid";
  const cents = Number(intPart) * 100 + (frac === "" ? 0 : Number(frac.padEnd(2, "0")));
  return Number.isSafeInteger(cents) && cents <= MAX_CENTS ? cents : "invalid";
}

function isGrouped(s: string, sep: string): boolean {
  const parts = s.split(sep);
  return /^\d{1,3}$/.test(parts[0]!) && parts.slice(1).every((p) => /^\d{3}$/.test(p));
}
