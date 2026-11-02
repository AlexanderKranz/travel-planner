/**
 * GitHub REST client for the feedback issues (docs/specs/feedback.md, D6/D11/D15): create an issue and search by
 * reference in the title. Keyed with `GITHUB_FEEDBACK_TOKEN` (fine-grained PAT, Issues read/write on one repo) and
 * `GITHUB_FEEDBACK_REPO` (`owner/name`); both server-only, never logged. Without them every call answers
 * `not_configured` and the reports stay pending.
 *
 * Calls never throw: the outcome is a typed result the delivery maps to the answer table. Every call is logged to
 * `api_calls` (provider `github`, cache `bypass`). Labels come from the fixed allowlist in the domain, never from input.
 */
import "server-only";
import { z } from "zod";
import { feedbackLabels, FEEDBACK_REF_RE, type FeedbackKind } from "@/lib/domain/feedback";
import { logApiCalls } from "@/lib/server/api-calls";
import { userAgent } from "./http";

export const GITHUB_API = "https://api.github.com";
export const GITHUB_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_MS = 3_600_000;
const MAX_BACKOFF_MS = 24 * 3_600_000;
const ISSUE_URL_RE = /^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/[0-9]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export type GithubConfig = { token: string; repo: string };

export function githubConfig(env: Record<string, string | undefined> = process.env): GithubConfig | null {
  const token = env.GITHUB_FEEDBACK_TOKEN?.trim();
  const repo = env.GITHUB_FEEDBACK_REPO?.trim();
  if (!token || !repo || !REPO_RE.test(repo)) return null;
  return { token, repo };
}

export type GithubIssue = { number: number; url: string };

/** Classified outcome. `rate_limited.retryAt` is when to try again. */
export type GithubResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "not_configured" }
  | { kind: "rate_limited"; retryAt: Date }
  | { kind: "auth" } // 401, 404 on the repo, or 403 without rate-limit headers (token expired, revoked, wrong repo or scope)
  | { kind: "validation" } // 422
  | { kind: "server"; status: number | null }; // 5xx, other statuses, unexpected body, network error or timeout
export type GithubFailure = Exclude<GithubResult<never>, { kind: "ok" }>;

const CreatedIssue = z.object({ number: z.number().int().positive(), html_url: z.string().regex(ISSUE_URL_RE) });
const SearchResponse = z.object({
  items: z.array(z.object({ number: z.number().int().positive(), html_url: z.string().regex(ISSUE_URL_RE), title: z.string() })),
});

/** Retry time from `retry-after` (seconds) or `x-ratelimit-reset` (epoch seconds), else one hour. Capped at 24 h. */
export function retryAtFrom(headers: Headers, now: Date = new Date()): Date {
  const retryAfter = Number(headers.get("retry-after"));
  const reset = Number(headers.get("x-ratelimit-reset"));
  let ms = DEFAULT_BACKOFF_MS;
  if (headers.get("retry-after") !== null && Number.isFinite(retryAfter) && retryAfter >= 0) ms = retryAfter * 1000;
  else if (headers.get("x-ratelimit-reset") !== null && Number.isFinite(reset) && reset > 0) ms = reset * 1000 - now.getTime();
  return new Date(now.getTime() + Math.min(MAX_BACKOFF_MS, Math.max(1000, ms)));
}

export function classifyFailure(status: number, headers: Headers, now: Date = new Date()): GithubFailure {
  if (status === 429 || status === 403) {
    const limited = status === 429 || headers.get("retry-after") !== null || headers.get("x-ratelimit-remaining") === "0";
    return limited ? { kind: "rate_limited", retryAt: retryAtFrom(headers, now) } : { kind: "auth" };
  }
  if (status === 401 || status === 404) return { kind: "auth" };
  if (status === 422) return { kind: "validation" };
  return { kind: "server", status };
}

type CallOpts = { userId?: string | null; now?: Date };

async function call<T>(
  endpoint: "issues_create" | "issues_search",
  path: string,
  init: RequestInit,
  parse: (body: unknown) => { value: T } | null,
  success: number,
  opts: CallOpts,
): Promise<GithubResult<T>> {
  const cfg = githubConfig();
  if (!cfg) return { kind: "not_configured" };
  const started = Date.now();
  let result: GithubResult<T>;
  let status: number | null = null;
  let errorCode: string | null = null;
  let remaining: number | null = null;
  try {
    const res = await fetch(`${GITHUB_API}${path.replace("{repo}", cfg.repo)}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": userAgent(),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
      cache: "no-store",
    });
    status = res.status;
    const rem = Number(res.headers.get("x-ratelimit-remaining"));
    remaining = res.headers.get("x-ratelimit-remaining") !== null && Number.isFinite(rem) ? rem : null;
    if (res.status === success) {
      const body: unknown = await res.json().catch(() => null);
      const parsed = parse(body);
      if (parsed === null) {
        errorCode = "zod";
        result = { kind: "server", status };
      } else result = { kind: "ok", value: parsed.value };
    } else {
      await res.body?.cancel().catch(() => undefined);
      result = classifyFailure(res.status, res.headers, opts.now);
      errorCode = `http_${res.status}`;
    }
  } catch (err) {
    errorCode = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network";
    result = { kind: "server", status: null };
  }
  await logApiCalls([
    {
      provider: "github",
      endpoint,
      cache: "bypass",
      status,
      ok: result.kind === "ok",
      latencyMs: Date.now() - started,
      quotaRemaining: remaining,
      errorCode,
      userId: opts.userId ?? null,
    },
  ]);
  return result;
}

/** Creates the issue. Labels are derived from `kind` through the fixed allowlist only. */
export function createIssue(input: { title: string; body: string; kind: FeedbackKind }, opts: CallOpts = {}): Promise<GithubResult<GithubIssue>> {
  return call(
    "issues_create",
    "/repos/{repo}/issues",
    { method: "POST", body: JSON.stringify({ title: input.title, body: input.body, labels: feedbackLabels(input.kind) }) },
    (b) => {
      const p = CreatedIssue.safeParse(b);
      return p.success ? { value: { number: p.data.number, url: p.data.html_url } } : null;
    },
    201,
    opts,
  );
}

/** Looks for an existing issue whose title carries `[FB-…]` (duplicate guard before a retry). `value: null` = none. */
export async function findIssueByRef(ref: string, opts: CallOpts = {}): Promise<GithubResult<GithubIssue | null>> {
  if (!FEEDBACK_REF_RE.test(ref)) return { kind: "validation" };
  const cfg = githubConfig();
  if (!cfg) return { kind: "not_configured" };
  const q = encodeURIComponent(`repo:${cfg.repo} in:title "${ref}" is:issue`);
  return call(
    "issues_search",
    `/search/issues?q=${q}&per_page=5`,
    { method: "GET" },
    (b) => {
      const p = SearchResponse.safeParse(b);
      if (!p.success) return null;
      const hit = p.data.items.find((i) => i.title.includes(`[${ref}]`));
      return { value: hit ? { number: hit.number, url: hit.html_url } : null };
    },
    200,
    opts,
  );
}
