/**
 * The answer to a change request or edit that wrote a new version (issue #158). PlanIterate is keyed by the shown
 * version, so the refresh that shows the new version remounts it and its state is gone: the model reply and the
 * shrink-guard notice never reached the user. The message is kept here (per tab, in memory) for the new version and
 * read once by the remounted component.
 */
const carried = new Map<string, string>();
const key = (tripId: string, version: number) => `${tripId}:${version}`;

export function carryReply(tripId: string, version: number, text: string): void {
  carried.set(key(tripId, version), text);
}

export function carriedReply(tripId: string, version: number): string | null {
  return carried.get(key(tripId, version)) ?? null;
}

export function dropCarriedReply(tripId: string, version: number): void {
  carried.delete(key(tripId, version));
}

/** Version number of the response's plan state when it differs from the base (a new version was written). */
export function newVersionOf(state: unknown, baseVersion: number): number | null {
  const v = (state as { version?: { meta?: { versionNo?: unknown } } | null } | null | undefined)?.version?.meta?.versionNo;
  return typeof v === "number" && Number.isInteger(v) && v !== baseVersion ? v : null;
}
