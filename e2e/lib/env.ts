import path from "node:path";

export const BASE_URL = "http://127.0.0.1:3000";
export const AUTH_DIR = path.join(__dirname, "..", ".auth");
export const SEED_FILE = path.join(AUTH_DIR, "seed.json");
export const PASSWORD = "E2e-test-pass-123!";
export const PROJECTS = ["mobile", "desktop"] as const;
export type ProjectName = (typeof PROJECTS)[number];

export function supabaseEnv() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  const serviceKey = process.env.SUPABASE_SECRET_KEY;
  if (!url || !anonKey || !serviceKey) {
    throw new Error("E2E needs NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, SUPABASE_SECRET_KEY (see scripts/e2e/env.sh)");
  }
  // Safety net: the suite creates users and wipes their data. It must never run against a hosted project.
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to run E2E against non-local Supabase host ${host}`);
  }
  return { url, anonKey, serviceKey };
}

export const emailOf = (key: string) => `${key}@e2e.test`;

export type Seed = {
  purposeId: string;
  searchId: string; // saved destination suggestion list (find-destinations)
  tripId: string; // plan trip (items, plan edits, share, pdf)
  a11yTripId: string; // second plan trip with a seeded share link
  a11yToken: string;
  groupId: string;
  groupName: string;
};
export type SeedFile = Record<ProjectName, Seed>;
