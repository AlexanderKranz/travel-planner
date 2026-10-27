import { z } from "zod";

/** Real calendar date as YYYY-MM-DD (rejects 2026-02-31). */
export const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const [y, m, d] = value.split("-").map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    return (
      date.getUTCFullYear() === y &&
      date.getUTCMonth() === m - 1 &&
      date.getUTCDate() === d
    );
  }, "Not a real calendar date");

/** Birthdates: real date, not before 1900 (DB check), not in the future. */
export const BirthDate = IsoDate.refine((v) => v >= "1900-01-01", "Too early").refine(
  (v) => v <= new Date().toISOString().slice(0, 10),
  "In the future",
);

/** Optional text from forms: empty/blank strings become undefined. */
export function optionalText(max: number) {
  return z
    .string()
    .max(max)
    .transform((v) => (v.trim() === "" ? undefined : v.trim()))
    .optional();
}
