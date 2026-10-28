# Phase 5 spec: items, costs, share links, PDF

Status: proposed (architect, 2026-10-28; every call is listed as **[D#]** in section 10 for Alex to review).
Decisions and reasons: `docs/adr/0005-phase-5-share-export.md`. Conventions of the phase 1–4 specs apply unchanged (private schema, explicit grants, `(select auth.uid())`, composite same-owner FKs, DB + Zod limits, snake_case DB / camelCase TS, `ActionResult`, `logEvent` metadata only).

Scope: trip items (hotels, courses, car, flights booked …) with status and price, a code-computed cost summary, open-item checkboxes, revocable share links with a public read-only page, A4 PDF for owner and share link, admin events.
Not in phase 5: FX conversion, items sent to the LLM, user-written to-dos, LLM-suggested items, email sending, share analytics beyond counts.

---

## 1. Migrations (forward-only; latest on this branch is `…120018`)

| # | File | Content |
|---|---|---|
| 19 | `supabase/migrations/20261031120019_trip_items.sql` | `trip_items` |
| 20 | `supabase/migrations/20261031120020_share_links.sql` | `private.is_demo()`, `share_links`, `public.share_link_touch()` |
| 21 | `supabase/migrations/20261031120021_plan_open_done_retention.sql` | `plans.open_done`; purge function counts item activity |

### 1.1 `trip_items` (own table, not plan JSON) **[D1]**

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users` cascade |
| `trip_id` | uuid | no | | `foreign key (trip_id, owner_id) references public.trips (id, owner_id) on delete cascade` |
| `category` | text | no | | `in ('flight','stay','car','transport','activity','food','other')` (golf round = `activity`) |
| `title` | text | no | | `char_length between 1 and 120` |
| `status` | text | no | `'option'` | `in ('option','planned','booked','rejected')` **[D2]** |
| `price_cents` | bigint | yes | | `between 0 and 100000000`; null = price unknown |
| `price_basis` | text | no | `'total'` | `in ('total','per_person')` |
| `persons` | smallint | yes | | `between 1 and 50`; how many share a `total` price (null = party size) |
| `currency` | text | no | `'EUR'` | `~ '^[A-Z]{3}$'` |
| `day` | smallint | yes | | `between 1 and 60` (plan day `n`) |
| `ref` | text | yes | | `~ '^(node\|way\|relation)/\d{1,15}$'` (key into `plan.places`) |
| `url` | text | yes | | `char_length <= 500 and url ~ '^https?://'` |
| `notes` | text | yes | | `char_length <= 1000` |
| `created_at`, `updated_at` | timestamptz | no | `now()` | `private.set_updated_at()` trigger |

Index `(trip_id, day nulls last, created_at)`. RLS on; `revoke all … from anon, authenticated, public; grant select, delete …; grant insert (trip_id, category, title, status, price_cents, price_basis, persons, currency, day, ref, url, notes) …; grant update (category, title, status, price_cents, price_basis, persons, currency, day, ref, url, notes) …;` + four owner policies. Max 100 items per trip (code). Items never touch `trips.updated_at` (that would mark the plan outdated).

### 1.2 `share_links` **[D5][D6]**

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users` cascade |
| `trip_id` | uuid | no | | composite FK `(trip_id, owner_id) → trips` **on delete cascade** |
| `token_hash` | text | no | | `unique`, `~ '^[0-9a-f]{64}$'` (sha256 hex; the token itself is never stored) |
| `label` | text | yes | | `char_length between 1 and 60` ("Ben", "Familie") |
| `include_items` | boolean | no | `true` | items + costs visible on the share page/PDF |
| `expires_at` | timestamptz | yes | | `expires_at is null or expires_at > created_at` |
| `view_count` | integer | no | 0 | written only by `share_link_touch` |
| `last_viewed_at` | timestamptz | yes | | same |
| `created_at` | timestamptz | no | `now()` | |

Index `(trip_id)`. RLS on; `revoke all …; grant select (id, trip_id, label, include_items, expires_at, view_count, last_viewed_at, created_at) …` (column grant: `token_hash` unreadable by clients); `grant insert (trip_id, token_hash, label, include_items, expires_at) …; grant delete …`. **No update** (revoke = delete; other options = new link).
Policies: owner select/delete; insert `with check ((select auth.uid()) = owner_id and not (select private.is_demo()))` **[D9]**.
```sql
create function private.is_demo() returns boolean language sql stable security definer set search_path = ''
  as $$ select coalesce((select is_demo from public.profiles where id = auth.uid()), false) $$;
grant execute on function private.is_demo() to authenticated;   -- same pattern as private.is_admin()
create function public.share_link_touch(p_id uuid) returns void language sql security definer set search_path = ''
  as $$ update public.share_links set view_count = view_count + 1, last_viewed_at = now() where id = p_id $$;
revoke all on function public.share_link_touch(uuid) from public, anon, authenticated;
grant execute on function public.share_link_touch(uuid) to service_role;
```
Cascades: trip delete, the nightly 18-month purge and the demo reset (deletes trips) remove links and items. Share views do **not** extend retention.

### 1.3 Migration 21
- `alter table public.plans add column open_done text[] not null default '{}' check (cardinality(open_done) <= 50);` and `grant update (busy_until, open_done) on public.plans to authenticated;` (keys from `openItemKey`, 2.3) **[D4]**.
- `create or replace function private.purge_expired_trips()`: last update = `greatest(t.updated_at, p.updated_at, (select max(i.updated_at) from public.trip_items i where i.trip_id = t.id))` (`greatest` ignores nulls). Signature, grants, cron unchanged.

---

## 2. Domain (step 0, `src/lib/domain/items.ts`, `share.ts`)

```ts
export const ITEM_CATEGORIES = ["flight","stay","car","transport","activity","food","other"] as const;
export const ITEM_STATUSES = ["option","planned","booked","rejected"] as const;
export const CurrencyCode = z.string().regex(/^[A-Z]{3}$/);
export const MAX_ITEMS_PER_TRIP = 100;
export const TripItemInput = z.object({
  category: z.enum(ITEM_CATEGORIES), title: z.string().trim().min(1).max(120),
  status: z.enum(ITEM_STATUSES).default("option"),
  priceCents: z.number().int().min(0).max(100_000_000).nullable(),
  priceBasis: z.enum(["total","per_person"]).default("total"),
  persons: z.number().int().min(1).max(50).nullable(),
  currency: CurrencyCode.default("EUR"),
  day: z.number().int().min(1).max(60).nullable(),
  ref: OsmKey.nullable(),
  url: z.string().max(500).url().refine((u) => /^https?:\/\//.test(u)).nullable(),
  notes: z.string().trim().max(1000).nullable(),           // "" → null in the mapper
});
export type TripItem = z.infer<typeof TripItemInput> & { id: string; tripId: string; createdAt: string; updatedAt: string };
export type SharedItem = Omit<TripItem, "tripId" | "createdAt" | "updatedAt">;

export type Money = { minCents: number; maxCents: number };          // min === max → single value
export type CurrencyCosts = {
  currency: string;
  booked: { totalCents: number; perPersonCents: number };
  expected: { total: Money; perPerson: Money };                      // booked + planned + option groups (2.1)
  counts: Record<(typeof ITEM_STATUSES)[number], number>;
  unpriced: number;            // non-rejected items without a price
  incomplete: number;          // priced items whose total or per-person amount is unknown (no party size)
};
export type CostSummary = { partySize: number | null; currencies: CurrencyCosts[] };   // EUR first, then alphabetical
```
`share.ts`:
```ts
export const SHARE_EXPIRY_DAYS = [7, 30, 90] as const;
export const MAX_LINKS_PER_TRIP = 10;
export const ShareLinkInput = z.object({ label: z.string().trim().max(60).nullable(),
  expiresInDays: z.union([z.literal(7), z.literal(30), z.literal(90)]).nullable(), includeItems: z.boolean() });
export type ShareLink = { id: string; tripId: string; label: string | null; includeItems: boolean;
  expiresAt: string | null; createdAt: string; viewCount: number; lastViewedAt: string | null };
export type CreatedShareLink = { link: ShareLink; url: string };      // url only in the create response
export type PlanDocument = {                                         // input of share page and PDF
  plan: Plan; versionNo: number; versionAt: string; openDone: string[];
  items: SharedItem[] | null; costs: CostSummary | null;             // null = not shared / no items section
};
```
`result.ts` gains errors `demo_forbidden`, `no_plan`, `limit_reached`. `plan.ts`: reserved keys `items`/`costs` stay `z.unknown().optional()` and are never written (comment: "items live in `trip_items`").

### 2.1 Cost rules (pure, `src/lib/items/costs.ts`) **[D3]**
`computeCosts(items, partySize): CostSummary`, `itemAmounts(item, partySize): { totalCents: number|null; perPersonCents: number|null }`.
- Status meaning: `option` = candidate, not decided; `planned` = decided, not booked yet; `booked` = paid/confirmed; `rejected` = out.
- `n = item.persons ?? partySize`. `total` basis: `total = price`, `perPerson = n ? round(price / n) : null`. `per_person` basis: `perPerson = price`, `total = n ? price × n : null`.
- `rejected`: counted, never summed. Unpriced: counted in `unpriced`, not summed. Unknown amount → `incomplete += 1`, known parts still summed.
- `booked` sums booked items. `expected` = booked + planned + for **options** grouped by `(category, day ?? "none")`: each group adds its cheapest and its most expensive priced option (alternatives, e.g. the day-4 course choice).
- Reference check (golf fixture, section 9): booked per person 1 209,64 €; expected per person 1 679,64–1 769,64 € (matches `golftour-2027.md`).
- Per currency, no FX. Integer cents; `Math.round` (prices are ≥ 0).
- `partySize(entryCounts: number[] | null)` = sum of `group_entries.count` (members count 1), null without group. Share/PDF compute it server-side from counts only.

### 2.2 Money input (pure, `src/lib/items/money.ts`)
`parseMoney(input, locale): number | null | "invalid"` → cents. Accepts `432,64`, `432.64`, `1.234,56` (de), `1,234.56` (en), `459`; spaces and currency symbols stripped; empty → null. Display with `Intl.NumberFormat(locale, { style: "currency", currency })` in UI/PDF only.

### 2.3 Open-item keys (pure, `src/lib/plan/open-items.ts`)
`openItemKey(text)` = FNV-1a 32-bit hex of `text.trim().toLowerCase()` (8 chars, isomorphic, no crypto). Done state survives patches that keep the text; changed text = new open item. `toggleOpenItem(tripId, key, done)` writes `plans.open_done` (dedupe, drop keys not in the latest plan, max 50).

---

## 3. Server (backend-dev)

### 3.1 Files
```
src/lib/server/items.ts         "use server": listItems(tripId), createItem(tripId, input), updateItem(id, input),
                                setItemStatus(id, status), deleteItem(id)  → ActionResult; RLS session; 100 cap
src/lib/server/item-mapping.ts  row ↔ TripItem (+ test)
src/lib/server/share-token.ts   newShareToken() { token, hash }, hashShareToken(t), isShareTokenFormat(t)
src/lib/server/shares.ts        "use server": listShareLinks(tripId), createShareLink(tripId, input), revokeShareLink(id)
src/lib/server/plan-document.ts getOwnerPlanDocument(tripId) (RLS); getSharedPlanDocument(token, via) (admin client);
                                buildPlanDocument(parts) pure
src/lib/server/plans.ts         + toggleOpenItem(tripId, key, done)
```

### 3.2 Tokens **[D5]**
`token = randomBytes(32).toString("base64url")` (43 chars, 256 bit); `hash = sha256(token)` hex. Only the hash is stored; the URL `${appUrl()}/${plan.locale}/s/${token}` is returned once by `createShareLink` and shown with a copy button. Lost link → create a new one. `isShareTokenFormat` = `/^[A-Za-z0-9_-]{43}$/`, checked before any DB access.

### 3.3 `createShareLink` / `revokeShareLink`
Session (401) → `rateLimit("share-create:"+userId, 10, 60_000)` → profile `isDemo` → `demo_forbidden` → trip via RLS (404) → plan with `latest_version > 0` else `no_plan` → non-expired links `>= 10` → `limit_reached` → insert (hash only) → `logEvent("share.created", { linkId, expiresInDays, includeItems })`. Revoke: RLS delete, 0 rows → `not_found`; event `share.revoked { linkId }`. Expired links stay listed (marked expired) until revoked.

### 3.4 Public read path `getSharedPlanDocument(token, via)` **[D6][D7]**
Admin client (secret key), explicit column lists only, never `*`:
1. `share_links`: `id, owner_id, trip_id, include_items, expires_at` by `token_hash`. Missing or `expires_at <= now()` → `null`.
2. `plans`: `id, latest_version, open_done` by `trip_id`; `latest_version = 0` → `null`.
3. `plan_versions`: `plan, version_no, created_at` by `(plan_id, version_no = latest_version)`; `Plan.safeParse` fails → `null` + `share.invalid_plan` error event.
4. If `include_items`: `trip_items` (`id, category, title, status, price_cents, price_basis, persons, currency, day, ref, url, notes`), `trips.group_id` (only this column), `group_entries.count` (only this column) → `partySize` → `computeCosts`.
5. `rpc("share_link_touch", { p_id })` (not awaited for the response) + `logEvent("share.viewed", { userId: owner_id, props: { linkId, via } })`.
Returns `PlanDocument | null`. Every `null` renders the same 404 (no oracle between unknown, expired, revoked, no plan). Always the **latest** version; no external API calls (facts come from the plan snapshot).
A share shows: plan header (title, destination, dates, group counts, purpose name), summary, days, places, facts digest, flights, notes, open items with done state, packing; with `include_items` also items (title, status, price, day, link) and the cost summary; item notes only with `include_item_notes` (default off, since notes may hold booking codes). Never: emails, display name, member names/birthdates, trip notes, group/purpose text, version history, `input`.

### 3.5 Rate limits (in-memory `rateLimit`; IP used only as an in-memory key, never stored or logged) **[D8]**
| Key | Limit |
|---|---|
| `share-ip:{ip}` (page) | 60 / min |
| `share-tok:{hash[0..16]}` (page) | 120 / min |
| `share-pdf-ip:{ip}` | 6 / min |
| `pdf:{userId}` (owner) | 10 / min |
IP = first value of `x-forwarded-for`, else `"unknown"`. Page over limit → 429-style page text (`shared.rateLimited`); routes → 429 + `Retry-After`.

### 3.6 Events (admin aggregates; props metadata only)
`share.created`, `share.revoked`, `share.viewed {linkId, via: "page"|"pdf"}`, `share.invalid_plan` (error), `pdf.generated {via: "owner"|"share", days, items, bytes, ms}`, `pdf.failed {via, code}` (error). Unknown-token requests are **not** logged (bot noise). Never tokens, hashes, IPs, user agents, titles or text.

---

## 4. UI (frontend-dev)

### 4.1 Trip page (`src/app/[locale]/app/trips/[id]/page.tsx`)
Order: `PlanSection` → **`ItemsSection`** → **`SharePanel`** → facts. Items work without a plan; day select shows 1..`lengthDays` ("no day" default).

### 4.2 Components `src/components/items/`
- `items-section.tsx` (server): `listItems`, party size from the loaded group, `computeCosts`; renders `CostSummaryView` + `ItemList` + add button.
- `item-list.tsx`: grouped by day ("Day 3 · Mo 15.03." / "No day"), then category; rejected collapsed under "Rejected (n)". Card: category icon + label, title, `StatusControl`, price line ("229,50 € p. P. · 459 € total, shared by 2"), link (`target=_blank rel="noopener noreferrer"`, host shown), notes (line-clamp 3, expand), edit/delete (`ConfirmDialog`). Prop `readOnly` (share page): status as a text badge, no actions.
- `status-control.tsx` (client): `role="radiogroup"` of 4 buttons (Option / Planned / Booked / Rejected), 2 × 2 grid below `sm`, optimistic `setItemStatus`, `aria-checked`, `min-h-11`; colours as the reference badges (booked green, planned blue, option amber, rejected muted + strike-through title); the text label is always visible.
- `item-form.tsx` (client; dialog on desktop, full-screen sheet below `sm`): category, title, status, price (`inputMode="decimal"`, `parseMoney`, error text), basis toggle (total / per person), persons (for total basis, placeholder = party size), currency select (EUR, CHF, GBP, USD, DKK, SEK, NOK, PLN, CZK, HUF, TRY + the plan country currency if different), day, link, notes. Prefill props `{ title?, category?, day?, ref? }`.
- **Code-only quick add** **[D10]**: in day cards each referenced place gets a small "+ item" action (prefill title = place name, `ref`, `day`, category `activity`, status `option`, no price); `plan-flights.tsx` leg rows get "+ item" (category `flight`, title "LH 1148 FRA → AGP", day 1 or last). No LLM.
- `cost-summary.tsx`: per currency a compact table: rows Booked · Expected (range), columns per person and total; party-size line ("for 2 people" / "no group: set persons per item for per-person amounts"); hints for `unpriced`/`incomplete`/rejected counts. Below `sm` a stacked definition list. Note "Prices are your own entries; no currency conversion."

### 4.3 Open items (`src/components/plan/plan-lists.tsx`)
Checkbox per open item (`openItemKey`), `toggleOpenItem`, done = strike-through; read-only on older versions and on the share page. Optimistic, revert on error.

### 4.4 Share panel `src/components/share/`
- `share-panel.tsx` (server): `listShareLinks`; "Download PDF" (`/api/trips/{id}/pdf`); create disabled with reason for `no_plan`, demo (`share.demoDisabled`), limit.
- `share-create.tsx` (client): label, expiry (never / 7 / 30 / 90 days), checkbox "Include bookings and costs" (default on; hint "Anyone with the link sees items incl. prices") and checkbox "Include item notes" (default off; enabled only with bookings). After create: URL in a read-only input + "Copy" (`navigator.clipboard`, `aria-live` "Copied") + "Share…" (`navigator.share` when available) + note "Shown only once".
- `share-link-row.tsx`: label or "Link from {date}", expiry or "expired", "opened {n}× · last {relative}", "Revoke" with `ConfirmDialog`.

### 4.5 Public page `src/app/[locale]/s/[token]/page.tsx` (+ `not-found.tsx`)
- Server component, `export const dynamic = "force-dynamic"`; `generateMetadata` → `robots: { index: false, follow: false }`, `referrer: "no-referrer"`, title = plan title (generic title on 404). Must not match `protected-paths` (verify).
- `isShareTokenFormat` → rate limits → `getSharedPlanDocument(token, "page")` → `notFound()` on null.
- Renders `src/components/share/shared-plan-view.tsx`: read-only composition of `PlanHeader` (no outdated banner/regenerate), `PlanFlights`, `DayCard`s, `PlanLists`, facts strip, `ItemList readOnly`, `CostSummaryView`. Add `readOnly` props where components carry actions; the share page imports **no** owner server actions. Top bar: "Shared travel plan · version {n} · updated {date}" + "Download PDF" (`/api/share/{token}/pdf`). AI note and source lines as on the owner page. Footer "Created with Travel Planner".
- Chrome in the URL locale; prose as stored (plan locale).

### 4.6 i18n (de + en, same keys)
`items.{title, add, edit, delete, confirmDelete, empty, noDay, rejectedGroup, categories.<7>, statuses.<4>, fields.{category,title,status,price,basis,total,perPerson,persons,personsHint,currency,day,link,notes}, priceInvalid, sharedBy, limit, quickAdd}`, `costs.{title, booked, expected, perPerson, total, forPeople, noParty, unpriced, incomplete, rejected, noFx}`, `share.{title, create, label, expiry.{never,7,30,90}, includeItems, includeItemsHint, includeNotes, includeNotesHint, copy, copied, nativeShare, onceNote, revoke, confirmRevoke, expired, views, demoDisabled, noPlan, limit, pdf}`, `shared.{banner, version, updated, pdf, rateLimited, footer, notFoundTitle, notFoundText}`, `plan.openItems.{markDone, markOpen}`, `pdf.*` (5.3).
Accessibility: labels on every input, focus trap + return in dialogs, `aria-live` for optimistic errors, colour never the only status signal. 360 px: no horizontal scroll, buttons full width below `sm`, touch targets `min-h-11`.

---

## 5. PDF (pdf owner)

### 5.1 Library and runtime **[D11]**
- `@react-pdf/renderer@^4.3` (React 19 supported since 4.1; verify `npm view @react-pdf/renderer peerDependencies` before installing). `export const runtime = "nodejs"`, `maxDuration = 30`.
- `next.config.ts`: `serverExternalPackages: ["@react-pdf/renderer"]`; `outputFileTracingIncludes: { "/api/trips/[id]/pdf": ["./src/assets/fonts/**"], "/api/share/[token]/pdf": ["./src/assets/fonts/**"] }`.
- Fonts: Noto Sans Regular + Bold TTF (OFL, license file alongside) in `src/assets/fonts/`, registered once: `Font.register({ family: "NotoSans", fonts: [{ src: path.join(process.cwd(), "src/assets/fonts/NotoSans-Regular.ttf") }, { src: …Bold, fontWeight: 700 }] })`. Built-in Helvetica covers umlauts but not `→`/`≈` used in plan titles. `Font.registerHyphenationCallback((w) => [w])`. Fonts are subset on embed; expected size 100–400 KB (Vercel response limit 4.5 MB).

### 5.2 Files
```
src/lib/pdf/fonts.ts        registerFonts() idempotent
src/lib/pdf/plan-pdf.tsx    <PlanPdf doc t fmt/> (Document, A4, 15 mm margins, 9.5 pt body)
src/lib/pdf/render.ts       renderPlanPdf(doc: PlanDocument, locale): Promise<Buffer> (getTranslations({ locale, namespace: "pdf" }))
src/lib/pdf/filename.ts     pdfFileName(plan) → "costa-del-sol-2027-03-13.pdf" (ASCII slug, ä→ae, ß→ss)
src/app/api/trips/[id]/pdf/route.ts    GET: session 401, rateLimit, getOwnerPlanDocument (404, 409 no_plan), latest version
src/app/api/share/[token]/pdf/route.ts GET: token format + rate limits, getSharedPlanDocument(token, "pdf"), null → 404
```
Headers: `Content-Type: application/pdf`, `Content-Disposition: attachment; filename="…"`, `Cache-Control: private, no-store`, `X-Robots-Tag: noindex`, `Referrer-Policy: no-referrer`. Events per 3.6.
Labels in **`plan.locale`** (matches the prose) **[D12]**; dates via `Intl.DateTimeFormat(locale)`.

### 5.3 Layout (printable, black on white, one accent colour)
1. Header: title, destination, dates or months, length, group counts, purpose name; "AI-written itinerary from verified facts · version {n} · {date}".
2. Summary paragraph.
3. Flights (if `plan.flights`): fitting legs table + "Times can change · AeroDataBox, checked {date}".
4. Costs (if items): cost summary, then items table (day, category, title, status, per person, total; notes as a second line, URL host only).
5. Days: one block per day (`wrap={false}` when it fits a page): date + title, best-day marker, stops with time windows, activities (time, text, place name), note/warning.
6. Open items ("[x]"/"[ ]"), tips/warnings, packing.
7. Footer each page: "Sources: OpenStreetMap, Open-Meteo, AeroDataBox · generated {date}" + "{n}/{total}" (`render` prop).
`pdf.*` keys: `title, aiNote, version, days, day, best, note, warning, flights, flightsNote, costs, items, openItems, tips, packing, sources, generated, page, statuses.<4>, categories.<7>, perPerson, total, booked, expected, datesOpen`.

---

## 6. Admin and demo
- No new admin views (phase 6). Events in 3.6 feed "shares opened" and "PDFs exported". `share_links` gets no admin policy.
- Demo account: items and PDF allowed; share links forbidden in code (`demo_forbidden`) and in the insert policy **[D9]**. `scripts/demo/reset.mjs` already deletes trips → cascade. Stretch: seed the golf demo trip with the items fixture.

---

## 7. Tests

Unit (Vitest, next to the code):
- `items/costs.test.ts`: golf fixture → booked p. P. 1 209,64 €, expected 1 679,64–1 769,64 €; rejected excluded; option groups by (category, day); `planned` always counted; per-person basis × party size; null party → `incomplete`; currencies separated; rounding.
- `items/money.test.ts`: de/en formats, thousands separators, invalid, empty.
- `plan/open-items.test.ts`: stable key, case/space-insensitive.
- `server/share-token.test.ts`: 43 chars base64url, 64-hex hash, format check.
- `server/plan-document.test.ts` (mocked admin client): exact `select` strings per table (snapshot), unknown/expired/no plan/invalid plan → null, `include_items=false` → no item/trip/group queries, `share_link_touch` called, no IP/token in event props.
- `server/shares.test.ts`: demo → `demo_forbidden`, no plan → `no_plan`, 10 active → `limit_reached`, URL contains the token, insert payload contains only the hash.
- `server/items.test.ts`: Zod limits, 100 cap, mapper round trip.
- `pdf/render.test.ts` (node env): golf + cruise documents render → Buffer starts with `%PDF`, < 1 MB, < 5 s; de labels with umlauts and `→` titles do not throw. `pdf/filename.test.ts`.
- Routes: owner pdf 401/404/409/429; share pdf 404 for a bad format without a DB call, 429.

pgTAP (`supabase/tests/rls.test.sql`, extend; update the header's migration range):
- `trip_items`: B cannot select/insert/update/delete A's items; A cannot insert an item for B's trip (23503); anon no privileges; `owner_id`/`trip_id` not updatable; checks reject bad currency/url/status.
- `share_links`: B sees none of A's; A cannot link B's trip (23503); `select token_hash` as `authenticated` → 42501; no update privilege; insert as a demo profile violates the policy; anon nothing.
- `share_link_touch`: not executable by `anon`/`authenticated`; increments as `service_role`.
- Trip delete cascades items + links; `purge_expired_trips()` keeps an old trip with a recently updated item, deletes it otherwise (links gone too).
- `plans.open_done` updatable by the owner only; `latest_version` still not updatable.

Manual: link in a logged-out private window, revoke → 404, PDF from both routes for the golf demo trip, 360 px.

---

## 8. Implementation split

**Step 0 — contract (backend-dev, ≤ 30 min):** `src/lib/domain/{items,share}.ts` (section 2), `result.ts` errors, exports; fixtures `src/lib/items/__fixtures__/items-golf.json` (from `golftour-2027.md`, all per person unless noted: flights 432,64 booked; Airbnb 459 total for 2 persons booked; car 255 total for 2 persons booked; Santana 95 day 1 planned; Santa Clara 110 + Río Real 115 day 2 planned; Sotogrande 420 day 3 booked; day 4 options Santana 95 / Río Real 115 / Santa Clara 110 / Los Naranjos 185; Baviera 55 day 5 planned; Finca Cortesín 382 rejected) and `src/lib/server/__fixtures__/plan-document-{golf,cruise}.json` (`PlanDocument` from the phase 3 plan fixtures; cruise without items); typed stubs for `items.ts`, `shares.ts`, `plan-document.ts` (return fixtures), `costs.ts`, `money.ts`, `open-items.ts`, `share-token.ts`.

| Owner | Writes | Depends on |
|---|---|---|
| **backend-dev** | step 0; migrations 19–21; `src/lib/items/{costs,money}.ts`; `src/lib/plan/open-items.ts`; `src/lib/server/{items,item-mapping,shares,share-token,plan-document}.ts`; `toggleOpenItem` in `plans.ts`; tests for these; pgTAP additions; `scripts/demo/reset.mjs` (stretch) | — |
| **frontend-dev** | `src/components/items/*`, `src/components/share/*`, `plan-lists.tsx`, `day-card.tsx` / `plan-flights.tsx` / `plan-header.tsx` (`readOnly`, quick add), trip page, `src/app/[locale]/s/[token]/{page,not-found}.tsx`, `messages/{de,en}.json` (all keys of 4.6 **including** `pdf.*`) | step-0 types + fixtures |
| **pdf** (backend-dev after the server part, or a third agent) | `package.json` dependency; `next.config.ts` (5.1); `src/assets/fonts/*`; `src/lib/pdf/*`; both pdf routes + tests | step-0 `PlanDocument` fixtures; `pdf.*` keys (tests use a local label stub until frontend lands) |

Order: step 0 → parallel → backend migrations + read path → frontend against real actions → PDF wired to `plan-document.ts` → manual smoke. `npm test`, `lint`, `typecheck` and `build` (react-pdf bundling) before each report. Contract changes after step 0 go through the architect.

---

## 9. Risks
- In-memory rate limits are per Vercel instance (phase 6 may move them to Postgres); tokens are 256-bit, so enumeration is infeasible regardless.
- react-pdf bundling in Next 15 is the likeliest snag; `serverExternalPackages` is the known fix. If it still fails, fall back to `renderToStream` in a route with `runtime = "nodejs"` and report before trying other libraries.
- Option grouping by (category, day) can misjudge items that are not alternatives; users fix it with `planned`/`day`.

---

## 10. Decisions (please review)
- **[D1]** Items live in their own table `trip_items` (per trip, not per plan version): status toggles create no plan versions, survive regenerate/restore, and are never sent to or written by the LLM. Plan JSON keys `items`/`costs` stay reserved and unused.
- **[D2]** Four statuses, not three: `option | planned | booked | rejected`. `planned` (decided, not booked yet) is needed for the reference trip (two decided rounds on day 2 must both count, not as alternatives).
- **[D3]** Costs computed in code per currency, no FX: booked total and an expected range (booked + planned + per (category, day) the cheapest–dearest option). Per person = price ÷ (item `persons` ?? party size from group entry counts).
- **[D4]** Open-item checkboxes stored as text keys in `plans.open_done`; user-written to-dos deferred.
- **[D5]** Share tokens: 256-bit random, only the sha256 hash is stored; the URL is shown once. Revoke = delete. Options (label, expiry 7/30/90/never, include items) fixed at creation; max 10 active links per trip.
- **[D6]** Public read via `getSharedPlanDocument` with the secret key and explicit column lists; always the latest version; identical 404 for every failure; no external API calls.
- **[D7]** A share shows the plan (incl. group counts and purpose name) and, by default, items and costs (opt-out per link). Item notes only if the owner ticks "Include item notes" (default off; notes may contain booking codes; orchestrator decision 2026-10-28, column `include_item_notes boolean not null default false` on share_links). Never names, birthdates, emails, trip notes, group/purpose text or version history.
- **[D8]** Views are counted (`view_count`) and logged as `share.viewed` without IP (not even hashed); IPs are only in-memory rate-limit keys. Unknown tokens are not logged. Views do not extend retention; item edits do.
- **[D9]** The demo account cannot create share links (code + RLS insert policy via `private.is_demo()`); items and PDF are allowed.
- **[D10]** No LLM item suggestions; quick add prefills items from plan places and verified flight legs in code, prices always entered by the user.
- **[D11]** PDF with `@react-pdf/renderer` v4 in Node route handlers, embedded Noto Sans, generated on demand, never stored.
- **[D12]** PDF labels in the plan's locale; share page chrome in the URL locale; the share URL uses the plan locale.
