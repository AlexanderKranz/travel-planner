import { notImplemented } from "@/lib/plan/not-implemented";

/** "432,64" / "1.234,56" (de) / "1,234.56" (en) / "459" -> cents; empty -> null. */
export function parseMoney(_input: string, _locale: string): number | null | "invalid" {
  return notImplemented("parseMoney");
}
