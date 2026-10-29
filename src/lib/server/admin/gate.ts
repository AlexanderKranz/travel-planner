import "server-only";
import { notFound } from "next/navigation";
import { getUserSession } from "../session";

/**
 * Admin check, server-side, on every admin read. Looks up the caller's own profile through the user session
 * (RLS: a user can only read their own row; `role` cannot be written by users, see migration profiles).
 * Anyone else - signed out, normal user, demo user - gets the 404 page, so the route does not reveal that it exists.
 */
export async function requireAdmin(): Promise<{ userId: string }> {
  const session = await getAdminSession();
  if (!session) notFound();
  return { userId: session.userId };
}

/** Non-throwing variant for server actions (they return a typed error instead of a 404). Null = not an admin. */
export async function getAdminSession() {
  const session = await getUserSession();
  if (!session) return null;
  const { data, error } = await session.supabase.from("profiles").select("role").eq("id", session.userId).maybeSingle();
  if (error || data?.role !== "admin") return null;
  return session;
}
