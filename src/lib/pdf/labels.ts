import de from "../../../messages/de.json";
import en from "../../../messages/en.json";

export type PdfT = (key: string, vars?: Record<string, string | number>) => string;

/** Builds a translator over a (possibly nested) `pdf` message object. Missing keys return the key. */
export function makeT(messages: unknown): PdfT {
  return (key, vars) => {
    let cur: unknown = messages;
    for (const part of key.split(".")) {
      if (cur && typeof cur === "object" && part in cur) cur = (cur as Record<string, unknown>)[part];
      else return key;
    }
    if (typeof cur !== "string") return key;
    return vars ? cur.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : cur;
  };
}

/** Reads the `pdf` namespace straight from messages/<locale>.json (works in route handlers and tests). */
export function loadPdfT(locale: string): PdfT {
  const all = (locale === "de" ? de : en) as unknown as Record<string, unknown>;
  return makeT(all.pdf);
}
