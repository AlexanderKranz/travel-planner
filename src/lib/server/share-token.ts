import "server-only";
import { notImplemented } from "@/lib/plan/not-implemented";

/** token: 43 chars base64url (256 bit); hash: sha256 hex of the token. Only the hash is stored. */
export function newShareToken(): { token: string; hash: string } {
  return notImplemented("newShareToken");
}
export function hashShareToken(_token: string): string {
  return notImplemented("hashShareToken");
}
export function isShareTokenFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
