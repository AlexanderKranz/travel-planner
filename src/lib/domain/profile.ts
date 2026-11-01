import { z } from "zod";
import { routing } from "@/i18n/routing";
import { isValidTimeZone } from "@/lib/facts/time-difference";
import { BirthDate } from "./common";

export const MAX_HOME_AIRPORTS = 5;

/** Format only. Whether the code exists is checked server-side with isKnownIata(). */
export const Iata = z.string().regex(/^[A-Z]{3}$/, "Expected a 3-letter IATA code");

export const HomeAirports = z
  .array(Iata)
  .max(MAX_HOME_AIRPORTS)
  .refine((list) => new Set(list).size === list.length, "Duplicate airports");

/** A real IANA zone ("Asia/Kolkata"), checked against the runtime's tz database. */
export const IanaTimeZone = z.string().max(64).refine(isValidTimeZone, "Unknown time zone");
export const HomeLocationName = z.string().trim().min(1).max(120);

export const Locale = z.enum(routing.locales);

export const Profile = z.object({
  id: z.string().uuid(),
  role: z.enum(["user", "admin"]),
  displayName: z.string().max(80).nullable(),
  locale: Locale,
  homeAirports: HomeAirports,
  birthdate: BirthDate.nullable(),
  /** Optional home place for the time difference (name + IANA zone, both null = default Europe/Berlin). */
  /** Both lenient on read: one odd stored value must not fail every page; the strict check is in ProfileUpdate. */
  homeLocation: z.string().nullable(),
  homeTimezone: z.string().nullable(),
  /**
   * GeoNames id and coordinates of the home, resolved by the server (never supplied by the browser). Used for drive
   * times only; null for a home saved before drive searches existed (it is picked once more).
   */
  homeGeoId: z.number().int().nullable(),
  homeLat: z.number().nullable(),
  homeLon: z.number().nullable(),
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
    homeLocation: HomeLocationName.nullable(),
    homeTimezone: IanaTimeZone.nullable(),
    /** GeoNames id of the picked home place; the server resolves the coordinates from it. */
    homeGeoId: z.number().int().positive().nullable(),
  })
  .partial()
  // Name and zone belong together: send both, and either set both or clear both (null).
  .refine((v) => (v.homeLocation === undefined) === (v.homeTimezone === undefined), {
    path: ["homeLocation"],
    message: "Send home location and time zone together",
  })
  .refine((v) => (v.homeLocation == null) === (v.homeTimezone == null), {
    path: ["homeLocation"],
    message: "Home location and time zone go together",
  })
  // A place id only makes sense together with its name.
  .refine((v) => v.homeGeoId == null || v.homeLocation != null, {
    path: ["homeGeoId"],
    message: "A home place id needs a home location",
  });
export type ProfileUpdate = z.infer<typeof ProfileUpdate>;

/** A home with coordinates, usable as the start of a drive search. */
export const hasHomeCoords = (p: Pick<Profile, "homeLocation" | "homeGeoId" | "homeLat" | "homeLon">): boolean =>
  p.homeLocation != null && p.homeGeoId != null && p.homeLat != null && p.homeLon != null;
