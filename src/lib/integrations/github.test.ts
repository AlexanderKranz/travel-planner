import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const logApiCalls = vi.fn();
vi.mock("@/lib/server/api-calls", () => ({ logApiCalls: (...a: unknown[]) => logApiCalls(...a) }));

import { classifyFailure, createIssue, findIssueByRef, githubConfig, retryAtFrom } from "./github";

const ISSUE_URL = "https://github.com/alex/travel/issues/7";
const fetchMock = vi.fn();
const reply = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

beforeEach(() => {
  process.env.GITHUB_FEEDBACK_TOKEN = "ghp_secret";
  process.env.GITHUB_FEEDBACK_REPO = "alex/travel";
  fetchMock.mockReset();
  logApiCalls.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  delete process.env.GITHUB_FEEDBACK_TOKEN;
  delete process.env.GITHUB_FEEDBACK_REPO;
  vi.unstubAllGlobals();
});

describe("githubConfig", () => {
  it("needs both variables and a valid repo", () => {
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t", GITHUB_FEEDBACK_REPO: "a/b" })).toEqual({ token: "t", repo: "a/b" });
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t" })).toBeNull();
    expect(githubConfig({ GITHUB_FEEDBACK_REPO: "a/b" })).toBeNull();
    expect(githubConfig({ GITHUB_FEEDBACK_TOKEN: "t", GITHUB_FEEDBACK_REPO: "a/b/../c" })).toBeNull();
  });
});

describe("createIssue", () => {
  it("posts title, body and the fixed labels, and logs the call without the token", async () => {
    fetchMock.mockResolvedValue(reply(201, { number: 7, html_url: ISSUE_URL }, { "x-ratelimit-remaining": "4990" }));
    const r = await createIssue({ title: "[FB-k3x9p2qa] Bug: x", body: "b", kind: "bug" }, { userId: "u1" });
    expect(r).toEqual({ kind: "ok", value: { number: 7, url: ISSUE_URL } });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.github.com/repos/alex/travel/issues");
    expect(init.headers.Authorization).toBe("Bearer ghp_secret");
    expect(JSON.parse(init.body)).toEqual({ title: "[FB-k3x9p2qa] Bug: x", body: "b", labels: ["bug", "reported-by-user"] });
    expect(JSON.parse(init.body).labels).not.toContain("claude");
    expect(logApiCalls).toHaveBeenCalledWith([
      expect.objectContaining({ provider: "github", endpoint: "issues_create", cache: "bypass", status: 201, ok: true, quotaRemaining: 4990, userId: "u1", errorCode: null }),
    ]);
    expect(JSON.stringify(logApiCalls.mock.calls)).not.toContain("ghp_secret");
  });
  it("answers not_configured without calling GitHub when the token is missing", async () => {
    delete process.env.GITHUB_FEEDBACK_TOKEN;
    expect(await createIssue({ title: "t", body: "b", kind: "idea" })).toEqual({ kind: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logApiCalls).not.toHaveBeenCalled();
  });
  it("treats an unexpected body as a server failure (Zod)", async () => {
    fetchMock.mockResolvedValue(reply(201, { number: "7", html_url: "https://evil.example/x" }));
    expect(await createIssue({ title: "t", body: "b", kind: "idea" })).toEqual({ kind: "server", status: 201 });
    expect(logApiCalls.mock.calls[0][0][0]).toMatchObject({ ok: false, errorCode: "zod" });
  });
  it("classifies network errors and timeouts as server failures and logs them", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await createIssue({ title: "t", body: "b", kind: "idea" })).toEqual({ kind: "server", status: null });
    expect(logApiCalls.mock.calls[0][0][0]).toMatchObject({ ok: false, errorCode: "network", status: null });
    const timeout = new Error("t");
    timeout.name = "TimeoutError";
    fetchMock.mockRejectedValueOnce(timeout);
    await createIssue({ title: "t", body: "b", kind: "idea" });
    expect(logApiCalls.mock.calls[1][0][0]).toMatchObject({ errorCode: "timeout" });
  });
  it.each([
    [401, "auth"],
    [404, "auth"],
    [403, "auth"],
    [422, "validation"],
    [500, "server"],
    [502, "server"],
  ])("maps %i to %s", async (status, kind) => {
    fetchMock.mockResolvedValue(reply(status, { message: "x" }));
    const r = await createIssue({ title: "t", body: "b", kind: "bug" });
    expect(r.kind).toBe(kind);
    expect(logApiCalls.mock.calls[0][0][0]).toMatchObject({ ok: false, errorCode: `http_${status}` });
  });
  it("maps 403/429 with rate-limit headers to rate_limited with the reset time", async () => {
    fetchMock.mockResolvedValueOnce(reply(403, {}, { "retry-after": "120" }));
    const a = await createIssue({ title: "t", body: "b", kind: "bug" }, { now: new Date("2026-11-02T10:00:00Z") });
    expect(a).toEqual({ kind: "rate_limited", retryAt: new Date("2026-11-02T10:02:00Z") });
    const reset = Math.floor(new Date("2026-11-02T11:00:00Z").getTime() / 1000);
    fetchMock.mockResolvedValueOnce(reply(403, {}, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) }));
    const b = await createIssue({ title: "t", body: "b", kind: "bug" }, { now: new Date("2026-11-02T10:00:00Z") });
    expect(b).toEqual({ kind: "rate_limited", retryAt: new Date("2026-11-02T11:00:00Z") });
    fetchMock.mockResolvedValueOnce(reply(429));
    expect((await createIssue({ title: "t", body: "b", kind: "bug" })).kind).toBe("rate_limited");
  });
});

describe("retryAtFrom / classifyFailure", () => {
  const now = new Date("2026-11-02T10:00:00Z");
  it("defaults to one hour and caps at 24 h", () => {
    expect(retryAtFrom(new Headers(), now)).toEqual(new Date("2026-11-02T11:00:00Z"));
    expect(retryAtFrom(new Headers({ "retry-after": "999999" }), now)).toEqual(new Date("2026-11-03T10:00:00Z"));
  });
  it("a 403 without rate-limit headers is an auth problem", () => {
    expect(classifyFailure(403, new Headers({ "x-ratelimit-remaining": "10" }), now)).toEqual({ kind: "auth" });
  });
});

describe("findIssueByRef", () => {
  it("searches by reference in the title and returns the matching issue", async () => {
    fetchMock.mockResolvedValue(
      reply(200, { items: [{ number: 3, html_url: "https://github.com/alex/travel/issues/3", title: "[FB-zzzzzzzz] other" }, { number: 7, html_url: ISSUE_URL, title: "[FB-k3x9p2qa] Bug: x" }] }),
    );
    const r = await findIssueByRef("FB-k3x9p2qa", { userId: null });
    expect(r).toEqual({ kind: "ok", value: { number: 7, url: ISSUE_URL } });
    const url = decodeURIComponent(fetchMock.mock.calls[0][0]);
    expect(url).toContain('q=repo:alex/travel in:title "FB-k3x9p2qa" is:issue');
    expect(logApiCalls.mock.calls[0][0][0]).toMatchObject({ endpoint: "issues_search", cache: "bypass", ok: true, userId: null });
  });
  it("only a title that starts with the reference matches", async () => {
    fetchMock.mockResolvedValue(reply(200, { items: [{ number: 3, html_url: ISSUE_URL, title: "Re: [FB-k3x9p2qa] quoted" }] }));
    expect(await findIssueByRef("FB-k3x9p2qa")).toEqual({ kind: "ok", value: null });
  });
  it("a 422 on the search is retryable, not final", async () => {
    fetchMock.mockResolvedValue(reply(422, { message: "x" }));
    expect(await findIssueByRef("FB-k3x9p2qa")).toEqual({ kind: "server", status: 422 });
  });
  it("returns null when nothing matches and rejects a malformed reference without a call", async () => {
    fetchMock.mockResolvedValue(reply(200, { items: [] }));
    expect(await findIssueByRef("FB-k3x9p2qa")).toEqual({ kind: "ok", value: null });
    fetchMock.mockClear();
    expect((await findIssueByRef('FB-" OR 1')).kind).toBe("server");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
