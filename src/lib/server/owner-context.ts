import "server-only";
import { z } from "zod";
import { HomeAirports, type Locale } from "@/lib/domain/profile";
import { createSupabaseAdminClient } from "./supabase/admin";

/**
 * The plan-owner values a write grantee's plan run uses (docs/specs/sharing.md 1.2): birthdate (for `is_self` and
 * `relativeToMe`), home airports (flight fallback), locale (first plan) and the display name.
 */
export type OwnerContext = {
  birthdate: string | null;
  homeAirports: string[];
  locale: Locale;
  displayName: string | null;
};

const Row = z.object({
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  home_airports: HomeAirports,
  locale: z.enum(["de", "en"]),
  display_name: z.string().nullable(),
});

const BirthdateRow = z.object({
  birthdate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
  display_name: z.string().nullable(),
});

/**
 * The GROUP owner's profile birthdate and display name (docs/specs/group-sharing.md 3.3), for the `is_self` entry of a
 * shared group (decision A) and for the anchors of a recipient's own trip (`ageRefs`). Same rules as `loadOwnerContext`:
 * secret key, two explicit columns, called only AFTER the group was read through RLS as the viewer (so never for a
 * disabled owner), and callers hand the client the birthdate only when the group has an `is_self` entry. Null when the
 * profile cannot be read; callers then fail closed.
 */
export async function loadGroupOwnerBirthdate(
  groupOwnerId: string,
): Promise<{ birthdate: string | null; displayName: string | null } | null> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("profiles")
      .select("birthdate, display_name")
      .eq("id", groupOwnerId)
      .maybeSingle();
    if (error || !data) return null;
    const row = BirthdateRow.safeParse(data);
    if (!row.success) return null;
    return { birthdate: row.data.birthdate, displayName: row.data.display_name };
  } catch {
    return null;
  }
}

/**
 * Reads the owner's profile values with the SECRET KEY (RLS bypass is intended and the only way: `profiles` is
 * self-only). Rules: one explicit column list, never `*`; call it only AFTER the trip was read through RLS as the
 * viewer, so `ownerId` comes from a row the viewer may see (a disabled owner's trips are hidden, so this never reaches
 * one); the values never go to the client (callers hand the pipeline birthdate, airports and locale, and the UI only
 * the display name and computed ages). Null when the profile cannot be read; callers then fail closed.
 */
export async function loadOwnerContext(ownerId: string): Promise<OwnerContext | null> {
  try {
    const { data, error } = await createSupabaseAdminClient()
      .from("profiles")
      .select("birthdate, home_airports, locale, display_name")
      .eq("id", ownerId)
      .maybeSingle();
    if (error || !data) return null;
    const row = Row.safeParse(data);
    if (!row.success) return null;
    return {
      birthdate: row.data.birthdate,
      homeAirports: row.data.home_airports,
      locale: row.data.locale,
      displayName: row.data.display_name,
    };
  } catch {
    return null;
  }
}
