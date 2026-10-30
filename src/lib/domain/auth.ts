import { z } from "zod";
import { Locale } from "./profile";

export const LoginRequest = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  locale: Locale,
});
export type LoginRequest = z.input<typeof LoginRequest>;

export const VerifyCodeInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  code: z.string().trim().regex(/^\d{6}$/),
  locale: Locale,
});
export type VerifyCodeInput = z.input<typeof VerifyCodeInput>;

/** Password bounds. 72 is bcrypt's limit (longer input is silently truncated). */
export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 72;

/** Login: only a sanity bound, so passwords set before a stricter rule still work. */
export const PasswordLoginInput = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(1).max(200),
  locale: Locale,
});
export type PasswordLoginInput = z.input<typeof PasswordLoginInput>;

/** Setting / changing the password (Settings, and after a reset link). */
export const SetPasswordInput = z
  .object({
    password: z.string().min(PASSWORD_MIN).max(PASSWORD_MAX),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, { path: ["confirm"], message: "mismatch" });
export type SetPasswordInput = z.input<typeof SetPasswordInput>;

/** Query of /auth/confirm (magic link, token-hash flow; `recovery` = password reset link). */
export const ConfirmQuery = z.object({
  token_hash: z.string().min(10).max(200),
  type: z.enum(["email", "magiclink", "signup", "invite", "recovery"]),
  locale: Locale.optional().catch(undefined),
  next: z.string().optional(),
});

/**
 * Query of /auth/confirm for Supabase's default email link (PKCE): Supabase verifies the token and
 * redirects back with `?code=`. Only works in the browser that requested the link (verifier cookie).
 */
export const ConfirmCodeQuery = z.object({
  code: z.string().min(10).max(200),
  locale: Locale.optional().catch(undefined),
  next: z.string().optional(),
});

/** Only same-site relative paths; blocks open redirects like "//evil.com", "/\\evil.com", "/%2Fevil.com". */
export function safeNextPath(next: string | undefined, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  // Control characters are stripped by URL parsers ("/\t/evil.com" -> "//evil.com").
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback;
  // Encoded slashes/backslashes/controls could be decoded later by a proxy or the router.
  if (/%(?:2f|5c|0[0-9a-f]|1[0-9a-f]|7f)/i.test(next)) return fallback;
  return next;
}
