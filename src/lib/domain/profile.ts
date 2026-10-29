import { z } from "zod";
import { routing } from "@/i18n/routing";
import { BirthDate } from "./common";

export const MAX_HOME_AIRPORTS = 5;

/** Format only. Whether the code exists is checked server-side with isKnownIata(). */
export const Iata = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter IATA code");

export const HomeAirports = z
  .array(Iata)
  .max(MAX_HOME_AIRPORTS)
  .refine((list) => new Set(list).size === list.length, "Duplicate airports");

export const Locale = z.enum(routing.locales);

export const Profile = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "admin"]),
  displayName: z.string().max(80).nullable(),
  locale: Locale,
  homeAirports: HomeAirports,
  birthdate: BirthDate.nullable(),
  /** Shared demo account: cannot delete the account or change the email. */
  isDemo: z.boolean(),
  /** When the getting-started guide was finished or skipped; null = not yet. */
  onboardingDoneAt: z.string().nullable(),
});
export type Locale = z.infer<typeof Locale>;
export type Profile = z.infer<typeof Profile>;

export const ProfileUpdate = z
  .object({
    displayName: z
      .string()
      .max(80)
      .nullable()
      .transform((v) => (v === null || v.trim() === "" ? null : v.trim())),
    locale: Locale,
    homeAirports: HomeAirports,
    birthdate: BirthDate.nullable(),
  })
  .partial();
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;
