import "server-only";
import { createHash, randomBytes } from "node:crypto";

/** token: 43 chars base64url (256 bit); hash: sha256 hex of the token. Only the hash is stored. */
export function newShareToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: hashShareToken(token) };
}
export function hashShareToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
export function isShareTokenFormat(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
