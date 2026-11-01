import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import golf from "./__fixtures__/plan-document-golf.json";

/**
 * Counts the database reads of one request for /app/trips/[id] (layout shell, page, PlanSection, ItemsSection),
 * using the real components and server functions against a fake Supabase client. Each query takes one virtual
 * round (10 ms of fake time); queries started together share a round, so the number of rounds is the length of the
 * longest chain of dependent reads (the time the user waits), and the number of queries is the load on the database.
 * The streamed fact panels (weather, places, flights, picture) are out of scope: they read api_cache, not user data.
 */
const h = vi.hoisted(() => ({ memo: new Map<unknown, Map<string, unknown>>() }));

vi.mock("server-only", () => ({}));
vi.mock("react", async (orig) => {
  const actual = await orig<typeof import("react")>();
  // Request-scoped like React's: one store per wrapped function, keyed by the argument list; reset per test request.
  const cache = <A extends unknown[], R>(fn: (...a: A) => R) =>
    (...args: A): R => {
      let store = h.memo.get(fn);
      if (!store) h.memo.set(fn, (store = new Map()));
      const key = JSON.stringify(args);
      if (!store.has(key)) store.set(key, fn(...args));
      return store.get(key) as R;
    };
  return { ...actual, cache, default: { ...actual, cache } };
});
vi.mock("next-intl/server", () => ({
  getTranslations: async () => (key: string) => key,
  setRequestLocale: () => {},
}));
vi.mock("@/i18n/navigation", () => ({ Link: () => null, redirect: () => {}, usePathname: () => "/" }));
vi.mock("@/lib/server/auth/actions", () => ({ signOut: async () => {} }));
vi.mock("@/components/app/nav-links", () => ({ NavLinks: () => null }));

const TRIP = "11111111-1111-4111-8111-111111111111";
const GROUP = "22222222-2222-4222-8222-222222222222";
const PURPOSE = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const PLAN = "55555555-5555-4555-8555-555555555555";
const plan = (golf as unknown as { plan: unknown }).plan;

type Log = { who: "user" | "admin"; table: string; select: string; kind: "single" | "list" | "rpc" };
const log: Log[] = [];

const versionRow = (no: number) => ({
  version_no: no, kind: "generated", created_at: `2026-10-0${no}T00:00:00Z`, feedback: null, restored_from: null,
  changed_days: [], model: "m", plan, input: { llm: { v: 1 }, index: {} }, pending_places: null, input_hash: "h", cost_micro_usd: 0,
});
const data: Record<string, { single?: unknown; list?: unknown }> = {
  profiles: {
    single: {
      id: USER, role: "user", display_name: "A", locale: "en", home_airports: ["MUC"], birthdate: null, is_demo: false,
      onboarding_done_at: null, home_location: "Bangkok", home_timezone: "Asia/Bangkok", disabled_at: null,
    },
  },
  trips: {
    single: {
      id: TRIP, title: null, dest_kind: "city", dest_name: "Marbella", dest_place_name: "Marbella", dest_geo_id: 1,
      dest_country_code: "ES", dest_admin1: null, dest_lat: 36.5, dest_lon: -4.9, dest_timezone: "Europe/Madrid",
      dest_radius_km: null, length_days: 3, start_date: "2038-03-13", months: [], group_id: GROUP, group_text: null,
      group_structure: null, group_parsed: null, group_parsed_hash: null, purpose_id: PURPOSE, wants_flights: false,
      origin_airports: [], notes: null, destination_search_id: null, created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    },
  },
  travel_groups: {
    single: {
      id: GROUP, name: "Two", notes: null, description: null, parsed_structure: null, parsed_hash: null, trait_keys: [],
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    },
  },
  group_entries: {
    list: [{ id: "e1", group_id: GROUP, kind: "composition", position: 0, count: 2, label: null, name: null, is_self: false, birthdate: null, age_mode: null, age: null, age_as_of: null, notes: null, traits: {} }],
  },
  trip_purposes: {
    single: {
      id: PURPOSE, name: "Golf", text: "golf", guided: {}, constraints: [], parsed_tags: null, parsed_hash: null,
      created_at: "2026-10-01T00:00:00Z", updated_at: "2026-10-01T00:00:00Z",
    },
  },
  plans: { single: { id: PLAN, latest_version: 2, busy_until: null, updated_at: "2026-10-02T00:00:00Z", open_done: [] } },
  plan_versions: { single: versionRow(2), list: [versionRow(2), versionRow(1)] },
  trip_items: { list: [] },
  app_settings: { list: [] },
};

function builder(who: Log["who"], table: string) {
  let select = "";
  const eq: Record<string, unknown> = {};
  const run = (kind: "single" | "list") => {
    log.push({ who, table, select, kind });
    return new Promise((resolve) =>
      setTimeout(() => {
        const row =
          table === "plan_versions" && kind === "single" && eq.version_no !== undefined
            ? versionRow(Number(eq.version_no))
            : (data[table]?.[kind] ?? null);
        // "plan->flights" style projections only need the plan column.
        resolve({ data: select.includes("flights:plan->flights") ? { flights: (plan as { flights?: unknown }).flights ?? null } : row, error: null });
      }, 10),
    );
  };
  const b: Record<string, unknown> = {};
  for (const m of ["gt", "order", "returns", "limit"]) b[m] = () => b;
  b.eq = (col: string, val: unknown) => ((eq[col] = val), b);
  b.select = (cols: string) => ((select = cols), b);
  b.maybeSingle = () => run("single");
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => (run("list") as Promise<unknown>).then(res, rej);
  return b;
}
const client = (who: Log["who"]) => ({
  from: (t: string) => builder(who, t),
  rpc: (fn: string) => {
    log.push({ who, table: fn, select: "", kind: "rpc" });
    return new Promise((resolve) =>
      setTimeout(() => {
        resolve({ data: [{ user_spent: 0, global_spent: 0 }], error: null });
      }, 10),
    );
  },
});
vi.mock("./supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    ...client("user"),
    auth: { getClaims: async () => ({ data: { claims: { sub: USER } } }) },
  }),
}));
vi.mock("./supabase/admin", () => ({ createSupabaseAdminClient: () => client("admin") }));
vi.mock("./events", () => ({ logEvent: async () => {} }));

import { AppShell } from "@/components/app/app-shell";
import { ItemsSection } from "@/components/items/items-section";
import { PlanSection } from "@/components/plan/plan-section";
import TripDetailPage from "../../app/[locale]/app/trips/[id]/page";
import { invalidateSettingsCache } from "./settings";
import { getUserSession } from "./session";

function findAll(node: unknown, type: unknown, out: ReactElement[] = []): ReactElement[] {
  if (Array.isArray(node)) node.forEach((n) => findAll(n, type, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<{ children?: unknown }>;
    if (el.type === type) out.push(el);
    findAll(el.props.children, type, out);
  }
  return out;
}

/** Renders the owner part of the trip page the way Next does: layout and page in parallel, then page children in parallel. */
async function request(searchParams: { v?: string } = {}) {
  log.length = 0;
  h.memo.clear();
  invalidateSettingsCache();
  vi.useFakeTimers({ toFake: ["setTimeout"] });
  const layout = (async () => {
    if (!(await getUserSession())) throw new Error("signed out");
    await AppShell({ locale: "en", children: null });
  })();
  const page = (async () => {
    const tree = await TripDetailPage({ params: Promise.resolve({ locale: "en", id: TRIP }), searchParams: Promise.resolve(searchParams) });
    const [planEl] = findAll(tree, PlanSection);
    const [itemsEl] = findAll(tree, ItemsSection);
    return Promise.all([
      (PlanSection as unknown as (p: unknown) => Promise<unknown>)(planEl.props),
      (ItemsSection as unknown as (p: unknown) => Promise<unknown>)(itemsEl.props),
    ]);
  })();
  let done = false;
  const all = Promise.all([layout, page]).finally(() => (done = true));
  let rounds = 0;
  while (!done) {
    await vi.advanceTimersByTimeAsync(10);
    rounds++;
    if (rounds > 60) throw new Error("did not finish");
  }
  vi.useRealTimers();
  const [, [planOut]] = await all;
  return { rounds, queries: log.length, planOut };
}

beforeEach(() => vi.useRealTimers());

describe("reads of one /app/trips/[id] request", () => {
  it("needs about 12 rounds or fewer and reads shared rows once", async () => {
    const { rounds, queries } = await request();
    console.log(`trip page: ${rounds} rounds, ${queries} queries`, log.map((l) => `${l.who}:${l.table}`).join(" "));
    expect(rounds).toBeLessThanOrEqual(12);
    const count = (table: string, sel: string) => log.filter((l) => l.table === table && l.select.includes(sel)).length;
    expect(count("trips", "dest_kind")).toBe(1); // the trip itself
    expect(count("profiles", "role")).toBe(1); // the profile
    expect(count("travel_groups", "trait_keys")).toBe(1);
    expect(count("trip_purposes", "parsed_tags")).toBe(1);
    expect(log.filter((l) => l.table === "plan_versions" && l.select.split(", ").includes("plan")).length).toBeLessThanOrEqual(1);
  });

  it("never selects the stored plan input on the page", async () => {
    await request();
    expect(log.filter((l) => l.table === "plan_versions").every((l) => !/(^|, )input(,|$)/.test(l.select))).toBe(true);
  });

  it("shows the requested version and keeps the cost the same", async () => {
    const latest = await request();
    const old = await request({ v: "1" });
    expect(old.rounds).toBeLessThanOrEqual(12);
    expect(JSON.stringify(old.planOut)).toContain('"versionNo":1');
    expect(JSON.stringify(latest.planOut)).toContain('"versionNo":2');
  });

  it("two requests share nothing", async () => {
    await request();
    const first = log.length;
    await request();
    expect(log.length).toBe(first);
  });
});
