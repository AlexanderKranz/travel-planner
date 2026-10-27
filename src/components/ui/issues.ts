export type Issue = { path: string; message: string };

/** True if any issue is at `path` or below it. */
export function hasIssue(issues: Issue[] | undefined, path: string): boolean {
  return !!issues?.some((i) => i.path === path || i.path.startsWith(`${path}.`));
}

/** Returns `message` when an issue matches `path`, else undefined (for Field `error`). */
export function errorAt(
  issues: Issue[] | undefined,
  path: string,
  message: string,
): string | undefined {
  return hasIssue(issues, path) ? message : undefined;
}
