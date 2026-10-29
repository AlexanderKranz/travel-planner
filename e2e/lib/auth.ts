import { createServerClient } from "@supabase/ssr";
import fs from "node:fs";
import path from "node:path";
import { AUTH_DIR, BASE_URL, PASSWORD, emailOf, supabaseEnv } from "./env";

/** Signs in with a password through @supabase/ssr and writes a Playwright storageState with the exact cookies the app expects. */
export async function writeStorageState(key: string): Promise<string> {
  const { url, anonKey } = supabaseEnv();
  const jar = new Map<string, { value: string; maxAge?: number }>();
  const sb = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => [...jar.entries()].map(([name, c]) => ({ name, value: c.value })),
      setAll: (list) => {
        for (const c of list) jar.set(c.name, { value: c.value, maxAge: c.options?.maxAge });
      },
    },
  });
  const { error } = await sb.auth.signInWithPassword({ email: emailOf(key), password: PASSWORD });
  if (error) throw new Error(`sign-in failed for ${key}: ${error.message}`);
  const host = new URL(BASE_URL).hostname;
  const cookies = [...jar.entries()].map(([name, c]) => ({
    name,
    value: c.value,
    domain: host,
    path: "/",
    expires: Math.floor(Date.now() / 1000) + (c.maxAge ?? 3600 * 24),
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  }));
  if (cookies.length === 0) throw new Error(`no session cookies for ${key}`);
  const file = path.join(AUTH_DIR, `${key}.json`);
  fs.writeFileSync(file, JSON.stringify({ cookies, origins: [] }));
  return file;
}

export const statePath = (key: string) => path.join(AUTH_DIR, `${key}.json`);
