import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (fn: () => Promise<void>) => afterTasks.push(fn),
}));
const afterTasks: (() => Promise<void>)[] = [];
const logEvent = vi.fn();
vi.mock("@/lib/server/events", () => ({ logEvent: (...a: unknown[]) => logEvent(...a) }));
let limitSetting = 10;
vi.mock("@/lib/server/settings", () => ({ getSetting: async () => ({ value: limitSetting, source: "default", locked: false }) }));
const deliver = vi.fn();
vi.mock("@/lib/server/feedback/deliver", () => ({ deliverFeedback: (...a: unknown[]) => deliver(...a) }));

const profile = vi.fn();
const session = vi.fn();
vi.mock("@/lib/server/session", () => ({ getUserSession: () => session() }));

const rpc = vi.fn();
const upload = vi.fn();
const updates: Record<string, unknown>[] = [];
const adminCreated = vi.fn();
vi.mock("@/lib/server/supabase/admin", () => ({
  createSupabaseAdminClient: () => {
    adminCreated();
    return {
      rpc: (...a: unknown[]) => rpc(...a),
      storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a), remove: vi.fn() }) },
      from: () => ({ update: (p: Record<string, unknown>) => ({ eq: async () => (updates.push(p), { error: null }) }) }),
    };
  },
}));

import { resetRateLimits } from "@/lib/server/rate-limit";
import { POST } from "./route";

const UID = "11111111-1111-4111-8111-111111111111";
const FID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

function req(fields: Record<string, string | File> = {}, headers: Record<string, string> = {}) {
  const form = new FormData();
  form.set("kind", "bug");
  form.set("text", "The map does not load, mail me at a@b.de");
  form.set("pagePath", "/de/app/trips/" + FID + "/edit");
  form.set("viewport", "360");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://localhost/api/feedback", { method: "POST", body: form, headers: { "user-agent": "Mozilla/5.0 (Linux; Android 14) Chrome/130.0.0.0 Mobile Safari/537.36", ...headers } });
}

beforeEach(() => {
  resetRateLimits();
  afterTasks.length = 0;
  updates.length = 0;
  [logEvent, deliver, profile, session, rpc, upload, adminCreated].forEach((m) => m.mockReset());
  limitSetting = 10;
  profile.mockResolvedValue({ data: { is_demo: false, locale: "en" }, error: null });
  session.mockResolvedValue({ userId: UID, supabase: { from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => profile() }) }) }) } });
  rpc.mockResolvedValue({ data: [{ outcome: "created", feedback_id: FID }], error: null });
  upload.mockResolvedValue({ error: null });
  deliver.mockResolvedValue({ outcome: "created", stop: false });
});

describe("POST /api/feedback", () => {
  it("401 when signed out, nothing else runs", async () => {
    session.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ ok: false, error: "unauthenticated" });
    expect(adminCreated).not.toHaveBeenCalled();
  });

  it("403 for the demo account before any count, upload or insert", async () => {
    profile.mockResolvedValue({ data: { is_demo: true, locale: "de" }, error: null });
    const res = await POST(req({ screenshot: new File([PNG], "s.png", { type: "image/png" }) }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ ok: false, error: "demo_forbidden" });
    expect(adminCreated).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("fails closed when the profile cannot be read", async () => {
    profile.mockResolvedValue({ data: null, error: { code: "x" } });
    expect((await POST(req())).status).toBe(500);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("saves the cleaned text with the resolved limit, answers received and delivers in after()", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, screenshot: "none" });
    expect(body.ref).toMatch(/^FB-[a-hjkmnp-z2-9]{8}$/);
    expect(rpc).toHaveBeenCalledWith("feedback_submit", expect.objectContaining({
      p_owner: UID,
      p_kind: "bug",
      p_body: "The map does not load, mail me at [email removed]",
      p_page_path: "/app/trips/:id/edit",
      p_locale: "en",
      p_limit: 10,
      p_client: "Chrome 130 · Android · 360px",
    }));
    expect(deliver).not.toHaveBeenCalled();
    await afterTasks[0]();
    expect(deliver).toHaveBeenCalledWith(FID, { userId: UID });
  });

  it("passes the resolved feedback_user_daily setting", async () => {
    limitSetting = 3;
    await POST(req());
    expect(rpc.mock.calls[0][1].p_limit).toBe(3);
  });

  it("429 when the daily limit is reached, no upload", async () => {
    rpc.mockResolvedValue({ data: [{ outcome: "limited", feedback_id: null }], error: null });
    const res = await POST(req({ screenshot: new File([PNG], "s.png") }));
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(upload).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith(expect.objectContaining({ event: "feedback.rate_limited" }));
    expect(afterTasks).toHaveLength(0);
  });

  it("fails closed when the limit function fails", async () => {
    rpc.mockResolvedValue({ data: null, error: { code: "57P01" } });
    const res = await POST(req());
    expect(res.status).toBe(500);
    expect(afterTasks).toHaveLength(0);
  });

  it("retries once with a new reference on a collision", async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: "23505" } });
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0][1].p_ref).not.toBe(rpc.mock.calls[1][1].p_ref);
  });

  it("burst guard: the 4th request in a minute is refused", async () => {
    for (let i = 0; i < 3; i++) expect((await POST(req())).status).toBe(200);
    const res = await POST(req());
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(rpc).toHaveBeenCalledTimes(3);
  });

  it("400 for invalid input (too short, unknown kind)", async () => {
    expect((await POST(req({ text: "short" }))).status).toBe(400);
    expect((await POST(req({ kind: "claude" }))).status).toBe(400);
    expect(rpc).not.toHaveBeenCalled();
  });

  it("stores a valid screenshot under <owner>/<id>.<ext> and sets screenshot_path", async () => {
    const res = await POST(req({ screenshot: new File([PNG], "x.jpg", { type: "image/jpeg" }) }));
    expect((await res.json()).screenshot).toBe("saved");
    expect(upload).toHaveBeenCalledWith(`${UID}/${FID}.png`, expect.any(Uint8Array), { contentType: "image/png", upsert: false });
    expect(updates).toEqual([{ screenshot_path: `${UID}/${FID}.png` }]);
  });

  it("rejects bad magic bytes before the limit is counted or anything is stored", async () => {
    const res = await POST(req({ screenshot: new File(["<svg/>"], "x.png", { type: "image/png" }) }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ ok: false, error: "bad_image" });
    expect(rpc).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("rejects a screenshot over 2 MB", async () => {
    const big = new Uint8Array(2 * 1024 * 1024 + 1);
    big.set(PNG);
    const res = await POST(req({ screenshot: new File([big], "x.png", { type: "image/png" }) }));
    expect(res.status).toBe(413);
    expect(await res.json()).toEqual({ ok: false, error: "too_large" });
    expect(rpc).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });

  it("keeps the report when the upload fails and says so", async () => {
    upload.mockResolvedValue({ error: { message: "x" } });
    const res = await POST(req({ screenshot: new File([PNG], "x.png") }));
    expect(res.status).toBe(200);
    expect((await res.json()).screenshot).toBe("failed");
    expect(updates).toHaveLength(0);
  });

  it("answers received even when GitHub fails (delivery runs after the response and cannot change it)", async () => {
    deliver.mockRejectedValue(new Error("github down"));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
  });

  it("logs metadata only", async () => {
    await POST(req());
    const logged = JSON.stringify(logEvent.mock.calls);
    expect(logged).toContain("feedback.submitted");
    expect(logged).not.toContain("map does not load");
    expect(logged).not.toMatch(/FB-[a-z0-9]{8}/);
  });
});
