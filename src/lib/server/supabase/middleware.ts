import { createServerClient } from "@supabase/ssr";
import type { NextRequest, NextResponse } from "next/server";
import { getSupabasePublicEnv } from "@/lib/supabase/env";

/**
 * Refreshes the Supabase session and writes refreshed cookies onto `response`
 * (the response produced by the next-intl proxy). Returns the verified
 * user id or null. getClaims() verifies the JWT locally when asymmetric
 * signing keys are enabled, otherwise asks the Auth server.
 */
export async function refreshSession(
  request: NextRequest,
  response: NextResponse,
): Promise<string | null> {
  let env: ReturnType<typeof getSupabasePublicEnv>;
  try {
    env = getSupabasePublicEnv();
  } catch {
    return null; // not configured (e.g. fresh checkout): treat as signed out
  }
  const supabase = createServerClient(env.url, env.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value, options } of cookiesToSet) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
        for (const [key, value] of Object.entries(headers ?? {})) {
          response.headers.set(key, value);
        }
      },
    },
  });
  const { data } = await supabase.auth.getClaims();
  const sub = data?.claims?.sub;
  return typeof sub === "string" ? sub : null;
}
