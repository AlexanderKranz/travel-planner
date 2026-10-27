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

/** Query of /auth/confirm (magic link, token-hash flow). */
export const ConfirmQuery = z.object({
  token_hash: z.string().min(10).max(200),
  type: z.enum(["email", "magiclink", "signup"]),
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
