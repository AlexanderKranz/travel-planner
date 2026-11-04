# Spec: share trips and purposes between users (issue #82)

Status: accepted (Alex, 2026-11-04). Decisions marked "(Alex)" were made by Alex; the others are architect calls, accepted with the spec. Answers of 2026-11-04 applied: no notification email, PDF also for read access, shared purposes in "Find destinations", transitive purpose visibility accepted, shares of a disabled owner hidden, CLAUDE.md rule 6 amended. Review of PR #123 applied (2026-11-04): share writes only through a guarded function, disabled owners hidden on every recipient path, access of trip-only purposes, atomic cap, deploy safety. All decisions are listed as **[D#]** in section 11.
Decisions and reasons: `docs/adr/0010-sharing-trips-and-purposes.md`. Conventions of the earlier specs apply unchanged (private schema, explicit grants, `(select auth.uid())`, composite same-owner FKs, DB + Zod limits, snake_case DB / camelCase TS, `ActionResult`, `logEvent` metadata only).

Scope: an owner gives another existing user live access to one trip (with its plan, plan versions and items) or one trip purpose, read-only or read/write. The recipient finds it under "Shared with me", sees who shared it and the level, and can leave it. A shared purpose can be used for the recipient's own trips and destination searches.
Not in scope: sharing travel groups (section 10), sharing with people who have no account, copies, notifications of any kind (no email, Alex), comments, live presence.

---

## 1. Model

### 1.1 Access levels **[D1] [D2] [D3]**

| Action on a trip | Owner | Write | Read |
|---|---|---|---|
| See trip, plan, versions, items, costs, open items, the group (full) and the purpose (read-only) | yes | yes | yes |
| Download the PDF | yes | yes | yes |
| Edit trip fields except group and purpose | yes | yes | no |
| Create, regenerate, iterate, edit, restore the plan; tick open items | yes | yes | no |
| Add, edit, delete items | yes | yes | no |
| Change `group_id`, `group_text`, `group_structure`, `purpose_id` | yes | no | no |
| Delete the trip, share / unshare, change access, manage share links | yes | no | no |
| Leave the share | – | yes | yes |

| Action on a purpose | Owner | Write | Read |
|---|---|---|---|
| See it, use it for own trips and own destination searches | yes | yes | yes |
| Edit name, text, guided answers, constraints | yes | yes | no |
| Delete, share / unshare, change access | yes | no | no |

- Live access, not copies (Alex). Two levels `read` and `write` (Alex).
- PDF for every access level (Alex): it only renders what the recipient can already see.
- Group on a shared trip: the recipient sees the full group, names and birthdates, read-only (Alex). The `is_self` entry is the owner: shown as the owner's display name with the age on the travel date, not with the owner's profile birthdate **[D4]**. The groups list of the recipient never shows it.
- Purpose on a shared trip: shown read-only on the trip (Alex). Editing it or picking it for own trips or searches needs a purpose share. A purpose share at either level allows picking it **[D5]**. A purpose reached only through a shared trip has access `read` and is not usable (3.1).
- `purpose_id` on a shared trip is owner-only, like `group_id` (owner-only group: Alex; purpose and the trip's one-off group text: architect, as recommended in the brief). The purpose is the owner's data, and a write grantee could otherwise attach their own purpose to the owner's trip **[D3]**.
- AI costs are charged to the acting user: their daily budget, their rate limits, their `ai_usage` rows (Alex). Already true in code, because every caller uses `session.userId`; the spec only keeps it that way.
- The demo account can neither share nor receive shares (Alex).
- No notification email (Alex): the recipient sees the new share in "Shared with me" **[D15]**.

### 1.2 Whose context is used **[D6]**

A plan on a shared trip belongs to the owner. When a write grantee generates or patches, the pipeline uses the **owner's** profile values: `birthdate` (for `is_self` and `relativeToMe`), `home_airports` (flight fallback) and, for a first plan, `locale`. A regeneration keeps the language of the latest version. So the same input gives the same hash and the same plan whoever presses the button, and the plan never switches language behind the owner's back. The owner's own behaviour is unchanged. The values are read on the server with the secret key, explicit columns, only after the trip was read through RLS (3.5). They never reach the client; the client gets the owner's display name and computed ages only.

---

## 2. Migration `supabase/migrations/20261110120035_sharing.sql` (forward-only, additive)

### 2.1 `trip_shares` and `purpose_shares` **[D7] [D24]**

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | | FK `auth.users` on delete cascade; set by `share_resource` (2.9) |
| `trip_id` / `purpose_id` | uuid | no | | composite FK `(trip_id, owner_id) → trips (id, owner_id)` / `(purpose_id, owner_id) → trip_purposes (id, owner_id)`, on delete cascade |
| `grantee_id` | uuid | no | | FK `auth.users` on delete cascade; `check (grantee_id <> owner_id)` |
| `access` | text | no | `'read'` | `in ('read','write')` |
| `created_at`, `updated_at` | timestamptz | no | `now()` | `private.set_updated_at()` trigger |

- `unique (trip_id, grantee_id)` / `unique (purpose_id, grantee_id)`. Index `(grantee_id, created_at desc)`.
- Grants: `revoke all … from anon, authenticated, public; grant select, delete … to authenticated`. **No insert and no update grant for `authenticated`**: rows are created and their access changed only by `public.share_resource` (2.9), which only the server can call.
- Policies (no insert or update policy):
  - select: `(select auth.uid()) = owner_id or ((select auth.uid()) = grantee_id and (select private.is_active(owner_id)))`
  - delete: owner (unshare) or grantee (leave)
- Max 10 grantees per trip and per purpose, enforced atomically in `share_resource` (2.9).

### 2.2 Helper functions (all `language sql stable security definer set search_path = ''`, execute revoked from `public, anon`, granted to `authenticated`) **[D8]**

```sql
private.is_active(p_user uuid) returns boolean  -- profiles.disabled_at is null for p_user (false for an unknown id)
private.shared_trip_ids()      returns uuid[]  -- trip_shares where grantee_id = auth.uid() and is_active(owner_id)
private.writable_trip_ids()    returns uuid[]  -- same, access = 'write'
private.shared_plan_ids()      returns uuid[]  -- plans.id where trip_id = any(shared_trip_ids())
private.writable_plan_ids()    returns uuid[]  -- plans.id where trip_id = any(writable_trip_ids())
private.shared_group_ids()     returns uuid[]  -- trips.group_id of shared_trip_ids(), not null
private.shared_purpose_ids()   returns uuid[]
  -- purpose_shares to me where is_active(owner_id)
  -- ∪ trips.purpose_id of shared_trip_ids() where is_active(<owner of that purpose>)
private.writable_purpose_ids() returns uuid[]  -- purpose_shares to me with access = 'write' and is_active(owner_id)
private.can_receive_share(p_user uuid) returns boolean  -- profile exists, not is_demo, is_active(p_user)
private.purpose_usable_by(p_purpose uuid, p_user uuid) returns boolean
  -- p_purpose belongs to p_user, or purpose_shares has (p_purpose, grantee p_user) and is_active(owner_id)
```
They read `trip_shares`, `purpose_shares`, `trips`, `trip_purposes`, `plans` and `profiles` as the definer, so the policies below never recurse (the `trips` policy calls a function that reads `trip_shares`, whose own policy does not mention `trips`), and `is_active` works although `profiles` is self-only. Policies always call them as `x = any ((select private.f()))`, so Postgres evaluates them once per statement (init plan), not per row. A user has at most 30 own trips and a few shares, so the arrays stay small.

**A disabled owner is hidden on every recipient path (Alex)**: their share rows (select policy), trips, plans, versions, items, groups and entries (`shared_trip_ids` and everything built on it), purposes, also when reached through someone else's shared trip (`shared_purpose_ids`, both branches), their name and email (`share_contacts`, 2.7), and their purposes as a reference for new trips and searches (`purpose_usable_by`). The owner-profile read of 1.2 runs only after the trip was visible, so it never reaches a disabled owner. Re-enabling brings everything back; no rows are changed. `is_active` tells a caller only whether a known user id is disabled; ids are random uuids and the function returns nothing else.

### 2.3 Policies added to existing tables (owner policies stay as they are)

| Table | New policy | Expression |
|---|---|---|
| `trips` | grantee select | `id = any ((select private.shared_trip_ids()))` |
| `trips` | write grantee update | using and with check `id = any ((select private.writable_trip_ids()))` |
| `plans` | grantee select | `id = any ((select private.shared_plan_ids()))` |
| `plans` | write grantee insert | with check `trip_id = any ((select private.writable_trip_ids()))` |
| `plans` | write grantee update | using and with check `id = any ((select private.writable_plan_ids()))` (grant stays `busy_until, open_done`) |
| `plan_versions` | grantee select | `plan_id = any ((select private.shared_plan_ids()))` |
| `plan_versions` | write grantee insert | with check `plan_id = any ((select private.writable_plan_ids()))` |
| `trip_items` | grantee select | `trip_id = any ((select private.shared_trip_ids()))` |
| `trip_items` | write grantee insert / update / delete | `trip_id = any ((select private.writable_trip_ids()))` |
| `travel_groups` | grantee select (read-only) | `id = any ((select private.shared_group_ids()))` |
| `group_entries` | grantee select (read-only) | `group_id = any ((select private.shared_group_ids()))` |
| `trip_purposes` | grantee select | `id = any ((select private.shared_purpose_ids()))` |
| `trip_purposes` | write grantee update | using and with check `id = any ((select private.writable_purpose_ids()))` (grant stays `name, text, guided, constraints`) |

No new delete policy anywhere except on `trip_items`: trips, plans, plan versions, groups and purposes are deleted by their owner only. `share_links` gets nothing: links stay owner-only. `destination_searches` gets nothing: lists stay owner-only, whatever purpose they use (3.8). `profiles` gets nothing (see 2.7 and 3.5). Every new policy depends on a share row; without one the helpers return empty arrays and the policies add no rows (6).

### 2.4 Owner of child rows written by a grantee **[D9]**

`owner_id` defaults to `auth.uid()`, which would be the grantee and break the composite FK. A `before insert` trigger sets it from the parent, always:

```sql
private.inherit_trip_owner()  -- plans, trip_items: new.owner_id := (select owner_id from public.trips where id = new.trip_id)
private.inherit_plan_owner()  -- plan_versions:     new.owner_id := (select owner_id from public.plans where id = new.plan_id)
```
`security definer set search_path = ''`, execute revoked from everyone (trigger-only). RLS `with check` runs after `before` triggers, so a stranger's insert gets the real owner's id and then fails the policy (42501). An unknown parent leaves `owner_id` null and fails `not null`.

Trigger names: `plans_00_inherit_owner`, `trip_items_00_inherit_owner`, `plan_versions_00_inherit_owner`. Same-event triggers fire in name order, and `plan_versions_assign_no` needs the final `owner_id` (it updates `plans … where owner_id = new.owner_id`). pgTAP checks the order.

### 2.5 Owner-only columns and purpose references **[D3] [D5] [D10] [D21]**

- **Trigger, not column grants.** Owner and grantee are both the `authenticated` role, so a column grant cannot tell them apart. `private.trips_owner_only()` `before update on trips`: when `(select auth.uid()) is not null and (select auth.uid()) <> old.owner_id` and any of `group_id, group_text, group_structure, purpose_id` is distinct from `old`, raise `'owner_only' using errcode = '42501'`. A null `auth.uid()` (secret key, for example the `group_parsed` cache write) passes. Holds for every path, also direct PostgREST calls.
- **Purpose references on `trips` and `destination_searches`.** On both tables drop the composite FK `(purpose_id, owner_id) → trip_purposes` and add `foreign key (purpose_id) references public.trip_purposes (id) on delete set null`. One trigger function `private.check_purpose_ref()` `before insert or update of purpose_id` on both tables: a non-null `new.purpose_id` must satisfy `private.purpose_usable_by(new.purpose_id, new.owner_id)`; otherwise raise `using errcode = '23503'` (both callers already map 23503 to `not_found`). Every existing row passes (same owner).
- **Unshare or leave a purpose.** `private.purpose_share_removed()` `after delete on purpose_shares` (definer), two statements:
  - `update public.trips set purpose_id = null where owner_id = old.grantee_id and purpose_id = old.purpose_id`. Those trips get a new `updated_at`, so their plans show as outdated; plan versions keep their snapshot.
  - `update public.destination_searches set purpose_id = null where owner_id = old.grantee_id and purpose_id = old.purpose_id`. The list keeps its `purpose_name` snapshot and cards, exactly as when a purpose is deleted (find-destinations section 9, "Purpose edited or deleted").
- A disabled purpose owner does not clear existing references (nothing changes on disable); the referenced purpose is simply not readable for the recipient while the owner is disabled, and loading a plan context or search treats it like a missing purpose.
- `group_id` keeps its composite FK on both tables: groups are not shareable.

### 2.6 Plans, versions, lock **[D11]**

- `plans.busy_by uuid null references auth.users on delete set null`. `private.plans_busy_by()` `before update of busy_until`: `new.busy_by := case when new.busy_until is null then null else (select auth.uid()) end`. Not granted to users.
- `plan_versions.created_by uuid null default auth.uid() references auth.users on delete set null`. Not in the insert grant (default only). Shown in the version list as "by {name}" when it differs from the viewer.
- `public.prune_plan_versions(p_plan_id uuid) returns void`, plpgsql security definer: raises 42501 unless `p_plan_id` is the caller's plan or in `writable_plan_ids()`; deletes `version_no <= latest_version - 30` (constant mirrored from `MAX_VERSIONS_KEPT`, a unit test compares them). Granted to `authenticated`. The `plan_versions` delete policy stays owner-only, so a write grantee can never delete history directly.

### 2.7 Lookups for the server

```sql
-- service_role only. Account by email for the share form. null for unknown, demo or disabled accounts.
public.share_user_by_email(p_email text) returns uuid
-- authenticated. Name and email of every user the caller shares with or receives from (both tables, both directions).
public.share_contacts() returns table (user_id uuid, display_name text, email text)
```
Both `security definer set search_path = ''`, email compared with `lower()` on `auth.users.email`. `share_contacts` returns only counterparts of the caller's own share rows, so it reveals nothing the caller has not already been given. Owners of incoming shares are returned only while `is_active(owner_id)`; grantees of the caller's own shares are always returned (the owner chose them and may want to remove a disabled one).

### 2.8 Admin aggregate

`public.admin_share_stats(p_month_start timestamptz) returns jsonb`, service_role only, counts only: `tripSharesRead`, `tripSharesWrite`, `purposeSharesRead`, `purposeSharesWrite`, `tripsShared` (distinct trips), `recipients` (distinct grantees), `grantsThisMonth`, `lookupsThisMonth`, `lookupMissesThisMonth` (from `app_events`). No ids, emails or titles.

### 2.9 `public.share_resource` (the only write path for grants) **[D24] [D25]**

```sql
public.share_resource(p_owner uuid, p_resource text, p_resource_id uuid, p_grantee uuid, p_access text)
  returns table (share_id uuid, created boolean)
-- plpgsql, security definer, set search_path = ''.
-- revoke all from public, anon, authenticated; grant execute to service_role only.
```
Called only by the server action (3.2) with the secret key, after the server has authorized the session. The function trusts nothing it is given and checks again, in this order (errors as `raise exception '<code>' using errcode = 'P0001'`; the server maps the message):
1. `p_resource in ('trip','purpose')`, `p_access in ('read','write')`, no argument null → `invalid`.
2. Owner: profile of `p_owner` exists, `not is_demo`, `is_active(p_owner)` → else `forbidden`.
3. Resource: `select … from public.trips | public.trip_purposes where id = p_resource_id and owner_id = p_owner for no key update` → no row: `not_found`. The row lock serializes every concurrent `share_resource` call for this resource; `for no key update` does not block the key-share locks that item, plan and share inserts take through their FKs.
4. `p_grantee = p_owner` → `self_share`; `not private.can_receive_share(p_grantee)` → `no_account`.
5. Existing row for `(resource, p_grantee)`: update `access` (no-op when equal) and return `(id, false)`. This runs before the cap, so changing the level works at 10 grantees.
6. New row: `count(*)` of the resource's share rows `>= 10` (under the lock of step 3, so two parallel calls cannot both pass) → `limit_reached`.
7. Insert with `owner_id = p_owner` and return `(id, true)`.

**Delete stays direct under RLS** (owner unshare, grantee leave): a delete can only take access away, there is no limit or eligibility to check, and the RLS policy already restricts it to the two people concerned. The server actions still log `sharing.revoked` / `sharing.left`; a direct PostgREST delete would only miss its event, which is analytics, not a control.

---

## 3. Server (backend-dev)

### 3.1 Domain `src/lib/domain/sharing.ts`

```ts
export const SHARE_ACCESS = ["read", "write"] as const;
export type ShareAccess = (typeof SHARE_ACCESS)[number];
export type Access = "owner" | ShareAccess;
export const SHARE_RESOURCES = ["trip", "purpose"] as const;
export type ShareResource = (typeof SHARE_RESOURCES)[number];
export const MAX_SHARES_PER_RESOURCE = 10;   // mirrored by share_resource step 6; a test compares them
export const SHARE_LOOKUPS_PER_DAY = 20;

export const ShareTarget = z.union([
  z.object({ email: z.string().trim().toLowerCase().email().max(254) }),
  z.object({ userId: z.string().uuid() }),          // admins only (3.3)
]);
export const ShareInput = z.object({
  resource: z.enum(SHARE_RESOURCES), resourceId: z.string().uuid(),
  target: ShareTarget, access: z.enum(SHARE_ACCESS),
});
export const ShareAccessInput = z.object({ resource: z.enum(SHARE_RESOURCES), shareId: z.string().uuid(), access: z.enum(SHARE_ACCESS) });
export const ShareIdInput = z.object({ resource: z.enum(SHARE_RESOURCES), shareId: z.string().uuid() });

export type Person = { id: string; name: string | null; email: string };   // name = display_name
export type Grant = { id: string; grantee: Person; access: ShareAccess; createdAt: string };
export type IncomingShare = { id: string; resource: ShareResource; resourceId: string; owner: Person; access: ShareAccess; createdAt: string };
export type ShareCandidate = { id: string; email: string; name: string | null };   // admin list
```
- `Trip` and `TripPurpose` gain `access: Access` and `ownerId: string`; `TripSummary` gains `access`, `sharedBy: Person | null` (incoming) and `shareCount: number` (own trips). `TRIP_COLUMNS` and `PURPOSE_COLUMNS` add `owner_id`.
- Access mapping: `owner_id === session.userId` → `"owner"`; else the viewer's share row for that resource → its `access`; else (a purpose readable only because it is on a trip shared with the viewer) → `"read"`. `TripPurpose` gains `usable: boolean` = owner or share row; only usable purposes appear in pickers and pass the search gate (3.8).
- `result.ts` gains `no_account` (share by email: no usable account), `self_share`, and `forbidden` is widened to "not allowed for this user" (admin and owner-only actions).

### 3.2 Actions `src/lib/server/sharing.ts` ("use server")

One module for both resources (a table map `{ trip: "trip_shares", purpose: "purpose_shares" }`). Grants are written only through `rpc("share_resource")` with the secret key (2.9); reads, unshare and leave use the user session.

| Action | Steps |
|---|---|
| `listGrants(resource, id)` | session → owner check via RLS read of the resource (`owner_id = me`, else `forbidden`) → share rows → `share_contacts()` for names and emails |
| `shareWith(input)` | session (401) → Zod → own profile: demo → `demo_forbidden` → resource read via RLS, owner only (`forbidden`) → resolve target (3.3) → `rpc("share_resource", { p_owner: session.userId, p_resource, p_resource_id, p_grantee, p_access })` → map errors (`self_share`, `no_account`, `limit_reached`, `not_found`, `forbidden`) → event `sharing.granted` when `created`, else `sharing.access_changed` |
| `setShareAccess(input)` | session → share row via RLS (`owner_id = me`, else `not_found`) → same `share_resource` call with that row's grantee (step 5 updates) → `sharing.access_changed` |
| `unshare(input)` | owner delete through RLS; 0 rows → `not_found` → `sharing.revoked` |
| `leaveShare(input)` | delete `where id = :id and grantee_id = me`; 0 rows → `not_found` → `sharing.left` |
| `listSharedWithMe()` | `trip_shares` and `purpose_shares` where `grantee_id = me` (RLS hides disabled owners), embedded resource summary, `share_contacts()`; two queries in parallel |
| `listShareCandidates()` | admin only (`getAdminSession`): users from the Auth admin API and `profiles` with the secret key, minus self, demo and disabled; email and display name only |

`p_owner` is always `session.userId`, never client input. The admin path differs only in how the grantee is found (3.3); an admin shares only resources they own.

Events (`app_events`, ids and flags only; never emails, names or titles) **[D12]**: `sharing.granted { resource, resourceId, access, via: "email" | "list" }`, `sharing.access_changed { resource, resourceId, access }`, `sharing.revoked { resource, resourceId }`, `sharing.left { resource, resourceId }`, `sharing.lookup { found }`. The `sharing.` prefix keeps them apart from the link events `share.*`.

### 3.3 Finding the recipient **[D13] [D14]**

- Owner (not admin): only `{ email }` is accepted. Limits, checked before the lookup: in memory `share-lookup:{userId}` 5 per minute, and durable `SHARE_LOOKUPS_PER_DAY` = 20 per Berlin day, counted as `sharing.lookup` rows of this user since `berlinMidnight()` (secret key, `count: "exact", head: true`). The durable count is needed because in-memory limits are per instance. Every lookup writes `sharing.lookup`, hit or miss, before the answer.
- `rpc("share_user_by_email")` with the secret key. null → `no_account`; the UI says "No account with this email. The app is invite-only: ask the admin to invite them." This reveals whether an email has an account (accepted by Alex). Demo and disabled accounts answer like unknown ones.
- Admin: the form shows the user list only, no email field (Alex). `{ userId }` from `listShareCandidates()`; `share_resource` checks self and `can_receive_share` again. No lookup limit, no `sharing.lookup` row.
- `{ userId }` from a non-admin → `forbidden`.
- Because no client can insert share rows (2.1), these limits and the email-only rule cannot be bypassed by calling the Data API with a known user id.

### 3.4 No notification **[D15]**

No email or other notice is sent (Alex). The recipient sees the share the next time they open `/app` ("Shared with me"). There is no new mail provider, secret or template.

### 3.5 Changes to existing server code **[D16]**

RLS now returns more rows than "my own" in a few places. Every list that means "mine" must filter by owner explicitly.

| File | Change |
|---|---|
| `trips.ts` `listTrips` | `.eq("owner_id", userId)` and `trip_shares(count)` for `shareCount`; shared trips come from `listSharedWithMe` |
| `trips.ts` `createTrip` | trip cap count gets `.eq("owner_id", userId)` (shared trips do not count) |
| `trips.ts` `updateTrip` | non-owner: the write keeps the stored `group_id, group_text, group_structure, purpose_id` (the trigger rejects a change; 42501 → `forbidden`). New argument `expectedUpdatedAt`: update `.eq("updated_at", expectedUpdatedAt)`; 0 rows on an existing trip → `conflict` (3.6) |
| `trips.ts` `deleteTrip` | unchanged (RLS: owner only; a grantee gets `not_found`) |
| `purposes.ts` `listPurposes` | `.eq("owner_id", userId)`; the trip form and the search form add shared (usable) purposes from `listSharedWithMe` |
| `purposes.ts` `updatePurpose` | `expectedUpdatedAt` as for trips; `deletePurpose` unchanged |
| `groups.ts` `listGroups` | `.eq("owner_id", userId)` (groups of shared trips are readable now) |
| `plan-store.ts` `hasBusyPlan(sb, userId)` | `.eq("busy_by", userId)`: the in-flight guard counts the actor's own runs, not a run someone else started on a shared plan |
| `plan-store.ts` `pruneVersions` | `rpc("prune_plan_versions", { p_plan_id })` instead of a delete |
| `plan-store.ts` `savePurposeTags`, `group-text.ts` `saveGroupParse` | take the row's `ownerId` (read through RLS before) instead of the actor's id for the `owner_id` filter; the AI call stays charged to the actor |
| `plan-pipeline.ts` `loadPlanContext` | adds `access`, `ownerId`; for a non-owner reads the owner's `birthdate, home_airports, locale, display_name` with the secret key (one explicit select by `trip.ownerId`) and uses them for `birthdate` / `homeAirports` (1.2). `read` access → `forbidden` for every write path (`generatePlan`, `iteratePlan`, `editPlanVersion`, `restoreVersion`, `toggleOpenItem`). Locale for a non-owner: latest version's `plan.locale`, else the owner's |
| `plan-document.ts` `getOwnerPlanDocument` | allowed for every access level (RLS already limits the reads); the PDF route needs no access check beyond a visible trip |
| `items.ts` | write actions check `access !== "read"` before the write (clear error instead of an RLS 0-row miss) |
| `discover/*` | section 3.8 |
| trip page reads (`trip-page-reads.test.ts`) | one more parallel read for the share badge (`trip_shares` row of the viewer or the grant count); the round count may stay at 7 if it joins an existing round |
| `account.ts` / `user-removal.ts` | no code change; cascades in 3.7 |

Group and purpose readers (`getGroup`, `getPurpose`) need no change: RLS lets the grantee read exactly the ones attached to the shared trip.

### 3.6 Two editors at once **[D17]**

- Plan: unchanged rules. The generation lock (`busy_until`) is per plan, so a second generation answers `busy` and the page shows the watching state; with `busy_by` not the viewer it adds "{name} is updating the plan". Iterate, edit and restore carry `baseVersion` and answer `conflict` when someone else added a version; the UI reloads the plan state and says "The plan was changed by someone else. Have a look at the new version and try again."
- Trip and purpose forms: optimistic check on `updated_at` (3.5); `conflict` → "Someone else changed this in the meantime. Reload to see the changes." Owners editing alone see no difference.
- Items and open-item ticks: last write wins (small rows, no merge). Accepted.
- No live updates: the other person sees changes on reload or the next poll that already runs while busy.

### 3.7 Account deletion, disable, retention **[D18]**

- Owner deleted: their trips and purposes cascade, and with them all shares; recipients lose them silently. A grantee's trips and destination searches that used the owner's purpose keep their rows, `purpose_id` set null (FK).
- Grantee deleted: their share rows cascade; `plans.busy_by` and `plan_versions.created_by` become null; versions they created stay with the owner's plan.
- The delete-account dialog adds one line: "Trips and purposes you shared are removed for the people you shared them with. Things shared with you stay with their owners."
- Disabled owner: hidden on every recipient path (2.2, Alex). Disabled grantee: signed out; shares stay until an admin deletes the account.
- Retention unchanged: a share does not keep a trip alive; a grantee's edits do, because they update the same `trips`, `plans` and `trip_items` rows the purge reads.
- Demo reset: nothing to do (demo has no share rows); trips cascade as before.

### 3.8 "Find destinations" with a shared purpose **[D21] [D22] [D23]**

A recipient can run a destination search with a purpose shared with them at either level (Alex). The list belongs to the recipient: owner-only RLS on `destination_searches` is unchanged, and the purpose owner never sees it. Changes against `docs/specs/find-destinations.md`:

| Section there | Change |
|---|---|
| 2, 13.1 form | The saved-purpose select lists own purposes, then an optgroup "Shared with me" with the owner's name. Default flight limit `maxBlockMinutes(purpose)` works unchanged on the shared purpose. A user without own purposes but with a shared one gets the chips (text mode is no longer forced). |
| 8 storage | `purpose_id` loses its composite same-owner FK and gets the plain FK plus `private.check_purpose_ref()` (2.5). `group_id` keeps its composite FK. |
| 9 gate 1 | The purpose loads through RLS **and** must be usable (`usable`, 3.1). A purpose visible only through a shared trip → `not_found`, the same answer the trigger would give. |
| 9 tags, 13.2 | A shared purpose with valid tags (`rowTags`, hash of the current content) is used as is: **no Haiku call** (`tagsFrom: "cached"`). Without valid tags the existing once-per-purpose call runs, charged to the searching user (`ai_usage` with their id), and `savePurposeTags` stores the tags on the purpose with the **purpose owner's** id (3.5). So every later user of that purpose reads them without a call. |
| 13.2 step 2 | The tag lookup for a typed text reads own purposes and purposes shared with me (`id in` my `purpose_shares`), not purposes seen only through a trip. |
| 6 hash, D6 there | Unchanged. `IdeaInput` holds tags, not the purpose id, and the hash stays scoped to the searching owner. A recipient and the owner with the same input each get their own list; no list is served across users. |
| 13.3 `adoptSource` | Unchanged rules; "saved purpose `P`" now includes a shared `P` (`purpose_name = P.name`). The update writes `purpose_id = P`, which the trigger accepts while the share exists. |
| 13.4 save as purpose | Unchanged. It creates or links the **searcher's own** purpose; step 4 (identical purpose) looks at own purposes only, because a link to a shared purpose would vanish on unshare. |
| 7, 13.5 prefill | `purposeId` = the search's `purpose_id` as today. `buildTripDraft` drops it (empty, as for a deleted purpose) when the purpose is no longer usable, so an old tab does not end in `not_found` from `createTrip`. The trip form accepts the shared purpose (2.5). |
| 9 failures | New row "Purpose unshared or left": like "Purpose edited or deleted": `purpose_id` is cleared by the trigger (2.5), the list keeps its `purpose_name` snapshot and cards. The FK action and the trigger both move `updated_at`, as a purpose delete already does today. |
| 9 events | `destination.searched` and `destination.search_failed`: `source` gains `"shared"` (saved purpose of another owner). No ids of the purpose owner. |

Demo: unaffected (demo has no shares). Retention: unchanged (newest 10, 90 days).

---

## 4. UI (frontend-dev)

### 4.1 Share box on the trip page and on the purpose page (owner only) **[D19]**
- Trip: a "People" block at the top of the existing `SharePanel` (links stay below, unchanged). Purpose: the same block on `/app/purposes/[id]`. Component `src/components/sharing/people-share.tsx` (client) with `grant-row.tsx`.
- Add form: email input (`type="email"`, `autocomplete="off"`), access as two chips in `grid-cols-2` ("Can view" | "Can edit"), button "Share". Admin: a native `<select>` of `listShareCandidates()` (email, name in brackets) instead of the input.
- Notice above the button, always visible on trips: "They will see the whole trip, including the travel group with names and birthdates." On purposes: "They can use this purpose for their own trips and destination searches. People they share those trips with can see it there."
- Rows: name or email (truncated, full value in `title`), the email in small text below when a name is shown, access select, remove button (`ConfirmDialog`). "Shared with {n} of 10".
- States: `no_account`, `self_share`, `limit_reached`, `rate_limited`, `demo_forbidden` (block disabled with `sharing.demoDisabled`).
- 360 px: input, chips and button stacked full width, rows wrap name above controls, touch targets `min-h-11`, no horizontal scroll. From `sm`: input and button in one row.

### 4.2 Lists
- `/app` trips column: own trips as today, a small "Shared · {n}" pill on cards with grants. Below them a section "Shared with me" (hidden when empty) with the same cards plus a badge "{name} · Can view" or "{name} · Can edit". Same on the purposes column and `/app/purposes`.
- Badge `src/components/sharing/share-badge.tsx`: text label always present (colour is not the only signal), wraps under the title at 360 px.

### 4.3 Shared trip or purpose page (recipient)
- Header badge as in the list plus "Leave" (`ConfirmDialog`: "You lose access. {name} keeps the trip."), then redirect to `/app`.
- Read: plan view in read-only mode (the `readOnly` props from phase 5: no iterate chips, no edits, no open-item ticks, no regenerate), items `readOnly`, "Download PDF" shown, no share panel, no "Back to suggestions", no edit or delete buttons.
- Write: everything except delete, share panel and "Back to suggestions". The trip form shows group and purpose as read-only text with the note "Only {name} can change the group and purpose." The plan view shows "by {name}" on versions created by someone else.
- Group block: read-only list of all entries; the `is_self` entry shows the owner's name and age.
- Purpose on a shared trip: name and text read-only; a link to the purpose only when it is also shared with the viewer.
- Shared purpose page: "Find destinations" button as on own purposes (opens the search with this purpose preselected).

### 4.4 Trip form and search form for own trips
The purpose select lists own purposes, then "Shared with me" purposes (optgroup) with the owner's name. Same in the "Find destinations" form (3.8).

### 4.5 i18n (de + en, same keys) **[D20]**
`sharing.{title, people, intro, email, emailPlaceholder, pickUser, add, adding, count, groupNotice, purposeNotice, access.{read, write}, remove, confirmRemove, changeAccess, demoDisabled, sharedPill, sharedWithMe, badge, leave, confirmLeave, ownerOnly, ownerOnlyContext, by, busyBy, conflictPlan, conflictForm, sharedOptgroup, errors.{no_account, self_share, limit_reached, rate_limited, forbidden, failed}}`, `settings.deleteAccount.sharedNote`, `admin.usage.{tripShares, purposeShares, tripsShared, recipients, grantsThisMonth, lookups, lookupMisses}`.

### 4.6 Admin page
"Usage" section gets one row of share counts from `admin_share_stats` (2.8). Nothing per user.

---

## 5. Tests

pgTAP (`supabase/tests/sharing.test.sql`, new file; actors A owner, B write grantee, C read grantee, D stranger, E demo, F owner who gets disabled; share rows created with `share_resource` as `service_role`):
- No share rows yet: B, C and D see exactly their own rows in `trips`, `plans`, `plan_versions`, `trip_items`, `travel_groups`, `group_entries`, `trip_purposes` (the widened policies add nothing without a share row).
- Write path: `authenticated` has no insert or update privilege on `trip_shares` / `purpose_shares` (42501 on a direct insert by A, also with a valid grantee id); `share_resource` is not executable by `authenticated` or `anon`. As `service_role`: A shares own trip and purpose; `p_owner` = A for B's trip → `not_found`; E as owner → `forbidden`; F as owner after disable → `forbidden`; self → `self_share`; E or F as grantee, or an unknown id → `no_account`; a repeat call changes `access` and returns `created = false`; with 10 grantees a change of access for one of them works and an 11th new grantee → `limit_reached`.
- Share rows: B sees own incoming row, D sees none; B and C can delete their own row (leave), D cannot; A can delete; anon nothing.
- Visibility: B and C see A's shared trip, its plan, versions, items, group, entries and purpose; D sees none; B's and C's own lists (`where owner_id = auth.uid()`) do not contain them; A's other trips and groups stay invisible to B; after unshare B sees nothing.
- Disabled owner (set `F.disabled_at`): B no longer sees F's share rows, trips, plans, versions, items, groups, entries or purposes; a purpose of F used on A's trip shared with B is not visible to B through that trip; `share_contacts()` for B does not return F, while F's own grantees list would still return B; `purpose_usable_by(F's purpose, B)` is false; clearing `disabled_at` brings everything back.
- Writes: B updates trip fields, inserts plan, plan version (gets `version_no`, `owner_id = A`, `created_by = B`), items, updates `busy_until` (`busy_by = B`) and `open_done`; C gets 42501 / 0 rows for each; B cannot delete the trip, the plan, versions, share links, groups or purposes; B cannot change `group_id`, `group_text`, `group_structure`, `purpose_id` (42501); the secret key (no `auth.uid()`) can still write `group_parsed`.
- `plan_versions_00_inherit_owner` fires before `plan_versions_assign_no` (insert by B succeeds).
- `prune_plan_versions`: B prunes only beyond 30; C and D get 42501.
- Purposes: B (write share) updates name/text, not `parsed_*`; C cannot; B and C attach A's shared purpose to their own trip; D cannot (23503); a purpose seen only through a shared trip cannot be attached (23503); after A unshares, B's trip has `purpose_id` null; A deleting the purpose clears it too.
- Destination searches: B and C insert a search with A's shared purpose; D cannot (23503); a purpose seen only through a shared trip cannot be used (23503); A sees none of B's searches; after A unshares or B leaves, B's search has `purpose_id` null and keeps `purpose_name` and `cards`; F's purpose (disabled owner) cannot be used.
- `share_user_by_email` not executable by `authenticated`; returns null for E and F. `share_contacts` returns only counterparts.
- Cascades: deleting A removes the shares; deleting B nulls `busy_by` and `created_by`.

Concurrency (`supabase/tests/sharing-concurrency.sh`, run in the `db-test` job against the local database): two `psql` sessions call `share_resource` for the same trip with 9 grantees and two different new grantees inside open transactions; the second waits on the row lock of step 3 and, after the first commits, gets `limit_reached`. Afterwards the trip has exactly 10 share rows.

Unit (Vitest, next to the code):
- `domain/sharing.test.ts`: Zod email normalisation, target union, limits; `MAX_SHARES_PER_RESOURCE` equals the SQL constant.
- `server/sharing.test.ts` (mocked clients): demo → `demo_forbidden`; non-owner → `forbidden`; unknown email → `no_account` and a `sharing.lookup { found: false }` event; 21st lookup of the day → `rate_limited`; `userId` from a non-admin → `forbidden`; `p_owner` is always the session user; every `share_resource` error code maps to its `ActionError`; `created = false` logs `sharing.access_changed`, not `sharing.granted`; `setShareAccess` on another owner's row → `not_found` without an RPC call; events contain no email, name or title.
- Access mapping (`trip-mapping.test.ts`, purpose mapping): owner → `owner`; share row → its level; purpose reached only through a shared trip → `read` with `usable: false`.
- `plan-pipeline.test.ts`: write grantee uses owner birthdate, home airports and plan locale (same input hash as the owner); read grantee → `forbidden` on every write path; AI usage logged with the actor's id; `hasBusyPlan` ignores a lock held by someone else.
- `plan-document-owner.test.ts` and the owner PDF route: a read grantee gets the document and the PDF; a stranger gets 404.
- `trips.test.ts` / `purposes.test.ts`: own lists filter by owner; cap counts own trips only; stale `expectedUpdatedAt` → `conflict`; grantee update keeps group and purpose.
- `plan-store.test.ts`: prune calls the RPC; `MAX_VERSIONS_KEPT` equals the SQL constant.
- `discover/pipeline.test.ts`: a shared purpose with valid tags runs with no Haiku call (`tagsFrom: "cached"`); an untagged shared purpose makes one call logged with the searcher's id and saves the tags with the purpose owner's id; a purpose seen only through a shared trip → `not_found`; event `source: "shared"`.
- `discover/store.test.ts`: `adoptSource` with a shared `P` sets `purpose_id` and `purpose_name`; the typed-text tag lookup finds tags on a purpose shared with me and ignores a purpose seen only through a trip.
- `discover/save-purpose.test.ts`: step 4 links only an identical own purpose, never a shared one.
- `discover/prefill.test.ts`: a search whose purpose is no longer usable gives an empty `purposeId`.
- Eval E10 stays green (no change to `IdeaInput` or the hash).

E2E outline (Playwright, mobile and desktop, users from `phase-6-e2e.md` plus a second user):
1. A shares a trip with B (write) by email; B sees it under "Shared with me" with the badge, edits the length, regenerates; A sees the new version "by B".
2. A changes B to read; B sees no edit controls and the plan form is gone; B downloads the PDF.
3. A shares a purpose with B; B picks it in the trip form of a new own trip and runs "Find destinations" with it; A unshares; B's trip shows no purpose and B's list keeps its label.
4. B leaves; the trip is gone from B's list.
5. Unknown email shows the invite-only message; demo login sees the share block disabled.
6. 360 px screenshots of the share box, a badge card and the shared trip header.

---

## 6. Delivery split **[D26]**

| PR | Owner | Content | Depends on |
|---|---|---|---|
| 1 | backend-dev | migration 35 (section 2), `supabase/tests/sharing.test.sql`, `sharing-concurrency.sh` + `db-test` step, header range update in `rls.test.sql`; existing pgTAP that expected 23503 for an item on another user's trip now expects 42501 | – |
| 2 | backend-dev | `domain/sharing.ts`, `result.ts`, `server/sharing.ts`, all changes of 3.5, 3.6 and 3.8, admin stats reader, unit tests | PR 1 deployed |
| 3 | frontend-dev | section 4, i18n keys, E2E | PR 2 |

**Why PR 1 is safe on its own:** every new policy and helper depends on a share row (`trip_shares`, `purpose_shares`), and after PR 1 no share row can exist. `authenticated` has no insert or update privilege on the share tables, and `share_resource` is executable by `service_role` only, which the current app never calls with it. So the widened policies return exactly the rows the old owner policies return, and the old `listTrips()` without an owner filter and the old plan-document reader without an access check see nothing new. The pgTAP case "no share rows yet" (section 5) proves it. The other changes are compatible with the current app: the purpose FK changes accept every existing row, the inherit-owner triggers set the value the default already set, the old `pruneVersions` delete still works for owners, and `busy_by` / `created_by` are new nullable columns.

**PR 2 order:** the owner filters and access checks of 3.5 (`listTrips`, the trip cap, `listPurposes`, `listGroups`, `hasBusyPlan`, `loadPlanContext`, `getOwnerPlanDocument`, items) ship in the same deploy as `shareWith`, and the action must not be reachable before them (no UI calls it until PR 3, and the action itself lands in PR 2 together with the filters). Nobody may create share rows by hand (SQL editor) before PR 2 is live.

---

## 7. CLAUDE.md ground rule 6

Amended (Alex approved, 2026-11-04; applied by the orchestrator):

> 6. **Users see only their own data.** Every user table has `owner_id` with an RLS policy `owner_id = auth.uid()`. Exception: a trip or trip purpose the owner shared with a named user (`trip_shares`, `purpose_shares`) is also visible to that user, read-only or read/write, through `private.*` helper functions; a shared trip shows its group and purpose read-only (`docs/specs/sharing.md`). Public share links are read through a server route by token only. Secrets stay server-side (never `NEXT_PUBLIC_`).

"Shared plans" became "Public share links" so the rule does not contradict direct shares.

---

## 8. Files

| Area | Files |
|---|---|
| DB | `supabase/migrations/20261110120035_sharing.sql`, `supabase/tests/sharing.test.sql`, `supabase/tests/sharing-concurrency.sh`, `.github/workflows/ci.yml` (`db-test` step), `supabase/tests/rls.test.sql` (header, one expectation) |
| Domain | `src/lib/domain/sharing.ts` (new), `result.ts`, `trip.ts`, `purpose.ts`, `destination-search.ts` (event source) |
| Server | `src/lib/server/sharing.ts` (new), `trips.ts`, `trip-mapping.ts`, `purposes.ts`, `purpose-insert.ts`, `groups.ts`, `plan-store.ts`, `plan-pipeline.ts`, `plan-document.ts`, `items.ts`, `group-text.ts`, `purpose-tagging.ts`, `admin/stats.ts`, `discover/{pipeline,store,save-purpose}.ts` |
| Pure | `src/lib/discover/prefill.ts` |
| UI | `src/components/sharing/{people-share,grant-row,share-badge,leave-button}.tsx` (new), `src/components/share/share-panel.tsx`, trip list and purpose list components, trip page, purpose page, trip form, `src/components/discover/discover-form.tsx`, plan view (`readOnly`, "by"), settings delete dialog, admin usage section |
| i18n | `messages/de.json`, `messages/en.json` |
| Docs | `docs/architecture.md` isolation line; a pointer from `docs/specs/find-destinations.md` sections 8 and 9 to section 3.8 here |

---

## 9. Risks
- The new policies widen seven tables (`trips`, `plans`, `plan_versions`, `trip_items`, `travel_groups`, `group_entries`, `trip_purposes`). A missing owner filter shows someone else's shared item in a "mine" list. Section 3.5 lists every known place; the pgTAP "own list" checks and a review grep for unfiltered `from("trips")`, `from("trip_purposes")`, `from("travel_groups")` guard it.
- Account enumeration: 20 lookups a day per user, invite-only app, so the exposure is small and logged (`lookupMissesThisMonth` on the admin page). Direct inserts with a guessed or known user id are impossible (2.1).
- Transitive purpose visibility (accepted by Alex): `shared_purpose_ids` includes purposes on trips shared with me, whoever owns the purpose (while that owner is active), so a write grantee's regeneration keeps the purpose. Stated in the purpose share notice.
- A shared purpose edited by its owner changes the tags; the recipient's next search has a new hash and makes a new ideas call on the recipient's budget, as an owner's own edit would.
- `share_resource` runs with the secret key and trusts no argument; its checks are the security boundary for grants, so every step of 2.9 has a pgTAP case.

---

## 10. Later: sharing groups (not in scope)
Groups are not shareable yet (Alex). Open problem for that step: the person you share with may already be a hand-entered member of your group ("Ben" with a typed birthdate). Linking that entry to Ben's account would let his own birthdate replace the typed one and show him "you" in the group, but there is no safe way to match a typed name to an account: names are not unique, and matching by email needs an email the member entry does not have. A future spec should let the owner link an entry to a grantee explicitly, and let the grantee confirm it, instead of guessing.

---

## 11. Decisions
- **[D1] (Alex)** Scope: trips (with plan, versions, items) and trip purposes. Groups later. Live access, no copies. Two levels, `read` and `write`.
- **[D2] (Alex)** Write allows editing trip fields, generating and patching the plan, items. The PDF is open to every access level (Alex, 2026-11-04). Owner only: delete, share and unshare, share links, the group. Recipient can leave. Shown under "Shared with me" with owner and level. Group on a shared trip fully visible (names, birthdates), read-only; the share box says so. Purpose on a shared trip read-only; editing or own use needs a purpose share. AI costs go to the acting user. Demo neither shares nor receives. Owner types an existing user's email, success only for existing accounts (enumeration accepted, rate-limited); admins pick from a list of all users except demo.
- **[D3]** `purpose_id` on a shared trip is owner-only, like `group_id` (Alex); the trip's one-off group (`group_text`, `group_structure`) counts as "the group" and is owner-only too.
- **[D4]** The `is_self` entry is shown to recipients as the owner's name and computed age, without the owner's profile birthdate: that birthdate belongs to the profile, not the group.
- **[D5]** A purpose share at either level allows picking it for own trips and searches; `write` also allows editing. Purpose references use a plain FK plus a trigger (same owner or shared with the row owner). Unshare and leave clear the reference. A purpose used on a shared trip is visible to the people that trip is shared with, whoever owns the purpose (accepted by Alex, 2026-11-04); it has access `read` and is not usable for their own trips or searches.
- **[D6]** Plans on shared trips use the owner's birthdate, home airports and plan locale, so the hash and language do not depend on who presses the button.
- **[D7]** Two access tables, `trip_shares` and `purpose_shares`, instead of one polymorphic table: real FKs with cascades on the resource and on both users, simple unique keys.
- **[D8]** RLS through `security definer` helpers returning id arrays, called once per statement. Shares of a disabled owner are hidden (Alex, 2026-11-04), on every recipient path, through one helper `private.is_active()`.
- **[D9]** Child rows written by a grantee take the parent's `owner_id` in a `before insert` trigger, so composite FKs and owner-based code stay valid.
- **[D10]** Owner-only trip columns are guarded by a trigger, not column grants (both users are `authenticated`).
- **[D11]** `plans.busy_by` for a per-actor in-flight guard; `plan_versions.created_by` for "by {name}"; pruning through a definer RPC so grantees cannot delete versions directly.
- **[D12]** Events under `sharing.*`, ids and flags only, written by the server actions.
- **[D13]** Lookup limit 5 a minute in memory plus 20 a Berlin day counted from `app_events`, every lookup logged.
- **[D14]** Demo and disabled accounts answer like unknown emails.
- **[D15] (Alex, 2026-11-04)** No notification email. The recipient sees the share in "Shared with me". (Replaces the earlier proposal of a notice email through Brevo, withdrawn.)
- **[D16]** "Mine" lists filter by `owner_id` explicitly; cache writes use the row owner's id.
- **[D17]** Concurrent editing: existing plan lock and `baseVersion` conflicts; optimistic `updated_at` check on trip and purpose forms; last write wins for items and open-item ticks.
- **[D18]** Deletion and retention by cascade; a share does not extend retention.
- **[D19]** Share box inside the existing share panel and on the purpose page; badges and "Shared with me" sections on the existing lists.
- **[D20]** New i18n namespace `sharing` (the `share` namespace stays for links).
- **[D21] (Alex, 2026-11-04)** A shared purpose (read or write) can be used in "Find destinations". The list belongs to the searcher and stays owner-only; `destination_searches.purpose_id` gets the same plain FK and trigger as trips. Unshare or leave clears it, and the list keeps its label and cards, as after a purpose delete.
- **[D22]** Tags of a shared purpose are read from the owner's purpose without a new Haiku call. Only an untagged purpose gets the existing once-per-purpose call, charged to the searcher and saved on the owner's purpose for every later user.
- **[D23]** No cross-user list reuse: the search hash stays per searching owner, so a recipient never receives a list built for the purpose owner. "Save as purpose" links only own purposes.
- **[D24] (orchestrator, after review of PR #123)** Grants are created and changed only by `public.share_resource`, a `security definer` function executable by `service_role` only and called by the server action after it authorized the session. Clients have no insert or update privilege on the share tables, so the email-only rule, the admin-only user list, the lookup limits and the events cannot be bypassed. Delete (unshare, leave) stays direct under RLS: it only removes access and needs no limit.
- **[D25] (orchestrator, after review of PR #123)** The 10-grantee cap is enforced inside `share_resource` under a row lock on the resource (`for no key update`), after an existing grant is resolved, so changing a level works at capacity and parallel calls cannot exceed 10.
- **[D26] (orchestrator, after review of PR #123)** The migration ships first and alone: without share rows the widened policies add nothing, and no client can create one. The server PR ships the owner filters and access checks in the same deploy as the share action.
