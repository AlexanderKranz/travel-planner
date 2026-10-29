import { createClient } from "@supabase/supabase-js";
import { PASSWORD, emailOf, supabaseEnv } from "./lib/env";
import { expect, test } from "./lib/fixtures";

test.describe("user isolation", () => {
  test("user B gets 404 on user A's trip and cannot export it", async ({ contextAs, seed }) => {
    const b = await (await contextAs("b")).newPage();
    const res = await b.goto(`/de/app/trips/${seed.tripId}`);
    expect(res?.status()).toBe(404);
    const pdf = await b.request.get(`/api/trips/${seed.tripId}/pdf`);
    expect(pdf.status()).not.toBe(200);
    expect(pdf.headers()["content-type"] ?? "").not.toContain("application/pdf");
  });

  test("user B cannot read or change A's rows through the data API", async ({ seed }, testInfo) => {
    const { url, anonKey } = supabaseEnv();
    const sb = createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const { error } = await sb.auth.signInWithPassword({ email: emailOf(`b-${testInfo.project.name}`), password: PASSWORD });
    expect(error).toBeNull();
    for (const [table, col, val] of [
      ["trips", "id", seed.tripId],
      ["plans", "trip_id", seed.tripId],
      ["plan_versions", "version_no", 1],
      ["travel_groups", "id", seed.groupId],
      ["group_entries", "group_id", seed.groupId],
      ["share_links", "trip_id", seed.a11yTripId],
    ] as const) {
      const r = await sb.from(table).select("*").eq(col, val);
      expect(r.error, table).toBeNull();
      expect(r.data, `${table} must be invisible`).toEqual([]);
    }
    const upd = await sb.from("trips").update({ title: "hijacked" }).eq("id", seed.tripId).select("id");
    expect(upd.data ?? []).toEqual([]);
    const del = await sb.from("travel_groups").delete().eq("id", seed.groupId).select("id");
    expect(del.data ?? []).toEqual([]);
    const ins = await sb.from("share_links").insert({ trip_id: seed.tripId, token_hash: "b".repeat(64) });
    expect(ins.error).not.toBeNull();
  });
});
