/**
 * Shared HTTP helper for keyless public APIs (server-side only).
 * Sends a descriptive User-Agent (Wikimedia and Overpass policies), applies a timeout and throws
 * errors that `cached()` can classify: `name === "TimeoutError"` and numeric `status`.
 */
import "server-only";

export class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message?: string) {
    super(message ?? `HTTP ${status}`);
    this.name = "HttpError";
    this.status = status;
  }
}

export class UpstreamError extends Error {
  /** HTTP 200 with an error payload (Wikimedia `error`, Overpass `remark`). */
  constructor(message: string) {
    super(message);
    this.name = "UpstreamError";
  }
}

export type HttpResult = { status: number; latencyMs: number; body: unknown };

export function userAgent(env: Record<string, string | undefined> = process.env): string {
  const contact = env.INTEGRATIONS_CONTACT?.trim() || "no-contact-configured";
  const url = env.APP_URL?.trim() || "https://travel-planner.invalid";
  return `TravelPlanner/1.0 (+${url}; ${contact})`;
}

async function run(url: string, init: RequestInit, timeoutMs: number): Promise<HttpResult> {
  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: { "User-Agent": userAgent(), Accept: "application/json", ...init.headers },
      signal: AbortSignal.timeout(timeoutMs),
      cache: "no-store",
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      const timeout = new Error(`Timeout after ${timeoutMs} ms`);
      timeout.name = "TimeoutError";
      throw timeout;
    }
    throw err;
  }
  const text = await res.text();
  const latencyMs = Date.now() - started;
  if (!res.ok) throw new HttpError(res.status);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError("Response is not JSON");
  }
  return { status: res.status, latencyMs, body };
}

export function fetchJson(url: string, opts: { timeoutMs?: number } = {}): Promise<HttpResult> {
  return run(url, { method: "GET" }, opts.timeoutMs ?? 8000);
}

/** JSON POST with optional extra headers (e.g. `Authorization` for keyed providers; never logged). */
export function postJson(
  url: string,
  body: unknown,
  opts: { timeoutMs?: number; headers?: Record<string, string> } = {},
): Promise<HttpResult> {
  return run(
    url,
    { method: "POST", headers: { "Content-Type": "application/json", ...opts.headers }, body: JSON.stringify(body) },
    opts.timeoutMs ?? 8000,
  );
}

export function postForm(
  url: string,
  form: Record<string, string>,
  opts: { timeoutMs?: number } = {},
): Promise<HttpResult> {
  return run(
    url,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    },
    opts.timeoutMs ?? 8000,
  );
}
