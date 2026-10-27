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

/** Only same-site relative paths; blocks open redirects like "//evil.com" or "/\\evil.com". */
export function safeNextPath(next: string | undefined, fallback: string): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.includes("\\")) return fallback;
  return next;
}
