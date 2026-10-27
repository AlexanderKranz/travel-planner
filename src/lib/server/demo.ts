import "server-only";

type Env = Record<string, string | undefined>;

/** Demo login is on only if DEMO_ENABLED is exactly "true" AND DEMO_EMAIL and DEMO_PASSWORD are set. */
export function isDemoEnabled(env: Env = process.env): boolean {
  return env.DEMO_ENABLED === "true" && Boolean(env.DEMO_EMAIL?.trim()) && Boolean(env.DEMO_PASSWORD);
}

/** Server-only credentials, null when the demo is off. The password never leaves the server. */
export function getDemoCredentials(env: Env = process.env): { email: string; password: string } | null {
  if (!isDemoEnabled(env)) return null;
  return { email: env.DEMO_EMAIL!.trim().toLowerCase(), password: env.DEMO_PASSWORD! };
}
