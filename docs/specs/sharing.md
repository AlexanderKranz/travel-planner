# Spec: share trips and purposes between users (issue #82)

Status: proposed (architect, 2026-11-04). Decisions marked "(Alex)" were made by Alex on 2026-11-04 and are binding; the others are architect calls for review. All decisions are listed as **[D#]** in section 11.
Decisions and reasons: `docs/adr/0010-sharing-trips-and-purposes.md`. Conventions of the earlier specs apply unchanged (private schema, explicit grants, `(select auth.uid())`, composite same-owner FKs, DB + Zod limits, snake_case DB / camelCase TS, `ActionResult`, `logEvent` metadata only).

Scope: an owner gives another existing user live access to one trip (with its plan, plan versions and items) or one trip purpose, read-only or read/write. The recipient finds it under "Shared with me", sees who shared it and the level, can leave it, and gets an email.
Not in scope: sharing travel groups (section 10), sharing with people who have no account, copies, shared purposes in "Find destinations", comments, live presence, notifications other than the one email.

---

## 1. Model

### 1.1 Access levels **[D1] [D2] [D3]**

| Action on a trip | Owner | Write | Read |
|---|---|---|---|
| See trip, plan, versions, items, costs, open items, the group (full) and the purpose (read-only) | yes | yes | yes |
| Edit trip fields except group and purpose | yes | yes | no |
| Create, regenerate, iterate, edit, restore the plan; tick open items | yes | yes | no |
| Add, edit, delete items | yes | yes | no |
| Download the PDF | yes | yes | no |
| Change `group_id`, `group_text`, `group_structure`, `purpose_id` | yes | no | no |
| Delete the trip, share / unshare, change access, manage share links | yes | no | no |
| Leave the share | – | yes | yes |

| Action on a purpose | Owner | Write | Read |
|---|---|---|---|
| See it, use it for own trips | yes | yes | yes |
| Edit name, text, guided answers, constraints | yes | yes | no |
| Delete, share / unshare, change access | yes | no | no |

- Live access, not copies (Alex). Two levels `read` and `write` (Alex).
- Group on a shared trip: the recipient sees the full group, names and birthdates, read-only (Alex). The `is_self` entry is the owner: shown as the owner's display name with the age on the travel date, not with the owner's profile birthdate **[D4]**. The groups list of the recipient never shows it.
- Purpose on a shared trip: shown read-only on the trip (Alex). Editing it or picking it for own trips needs a purpose share. A purpose share at either level allows picking it for own trips **[D5]**.
- `purpose_id` on a shared trip is owner-only, like `group_id` (owner-only group: Alex; purpose and the trip's one-off group text: architect, as recommended in the brief). The purpose is the owner's data, and a write grantee could otherwise attach their own purpose to the owner's trip **[D3]**.
- AI costs are charged to the acting user: their daily budget, their rate limits, their `ai_usage` rows (Alex). Already true in code, because every caller uses `session.userId`; the spec only keeps it that way.
- The demo account can neither share nor receive shares (Alex).

### 1.2 Whose context is used **[D6]**

A plan on a shared trip belongs to the owner. When a write grantee generates or patches, the pipeline uses the **owner's** profile values: `birthdate` (for `is_self` and `relativeToMe`), `home_airports` (flight fallback) and, for a first plan, `locale`. A regeneration keeps the language of the latest version. So the same input gives the same hash and the same plan whoever presses the button, and the plan never switches language behind the owner's back. The owner's own behaviour is unchanged. The values are read on the server with the secret key, explicit columns, only after the trip was read through RLS (3.5). They never reach the client; the client gets the owner's display name and computed ages only.

---

## 2. Migration `supabase/migrations/20261110120035_sharing.sql` (forward-only, additive)

### 2.1 `trip_shares` and `purpose_shares` **[D7]**

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | `auth.uid()` | FK `auth.users` on delete cascade |
| `trip_id` / `purpose_id` | uuid | no | | composite FK `(trip_id, owner_id) → trips (id, owner_id)` / `(purpose_id, owner_id) → trip_purposes (id, owner_id)`, on delete cascade |
| `grantee_id` | uuid | no | | FK `auth.users` on delete cascade; `check (grantee_id <> owner_id)` |
| `access` | text | no | `'read'` | `in ('read','write')` |
| `created_at`, `updated_at` | timestamptz | no | `now()` | `private.set_updated_at()` trigger |

- `unique (trip_id, grantee_id)` / `unique (purpose_id, grantee_id)`. Index `(grantee_id, created_at desc)`.
- Grants: `revoke all … from anon, authenticated, public; grant select, delete …; grant insert (trip_id|purpose_id, grantee_id, access) …; grant update (access) …`.
- Policies:
  - select: `(select auth.uid()) = owner_id or (select auth.uid()) = grantee_id`
  - insert: `(select auth.uid()) = owner_id and not (select private.is_demo()) and private.can_receive_share(grantee_id)`
  - update: owner only (using + with check)
  - delete: owner (unshare) or grantee (leave)
- Max 10 grantees per trip and per purpose: code (`MAX_SHARES_PER_RESOURCE`), not the DB.

### 2.2 Helper functions (all `language sql stable security definer set search_path = ''`, execute revoked from `public, anon`, granted to `authenticated`) **[D8]**

```sql
private.shared_trip_ids()      returns uuid[]  -- trip_shares where grantee_id = auth.uid() and the owner's profile has disabled_at is null
private.writable_trip_ids()    returns uuid[]  -- same, access = 'write'
private.shared_plan_ids()      returns uuid[]  -- plans.id where trip_id = any(shared_trip_ids())
private.writable_plan_ids()    returns uuid[]  -- plans.id where trip_id = any(writable_trip_ids())
private.shared_group_ids()     returns uuid[]  -- trips.group_id of shared_trip_ids(), not null
private.shared_purpose_ids()   returns uuid[]  -- purpose_shares to me (owner not disabled) ∪ trips.purpose_id of shared_trip_ids()
private.writable_purpose_ids() returns uuid[]  -- purpose_shares to me with access = 'write' (owner not disabled)
private.can_receive_share(p_user uuid) returns boolean  -- profile exists, not is_demo, disabled_at is null
```
They read `trip_shares`, `purpose_shares`, `trips`, `plans` and `profiles` as the definer, so the policies below never recurse (the `trips` policy calls a function that reads `trip_shares`, whose own policy does not mention `trips`). Policies always call them as `x = any ((select private.f()))`, so Postgres evaluates them once per statement (init plan), not per row. A user has at most 30 own trips and a few shares, so the arrays stay small.

A disabled owner's shares disappear for the recipients, as their share links answer 404 (runbook section 11). Re-enabling brings them back.

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

No new delete policy anywhere except on `trip_items`: trips, plans, plan versions, groups and purposes are deleted by their owner only. `share_links` gets nothing: links stay owner-only. `profiles` gets nothing (see 2.7 and 3.5).

### 2.4 Owner of child rows written by a grantee **[D9]**

`owner_id` defaults to `auth.uid()`, which would be the grantee and break the composite FK. A `before insert` trigger sets it from the parent, always:

```sql
private.inherit_trip_owner()  -- plans, trip_items: new.owner_id := (select owner_id from public.trips where id = new.trip_id)
private.inherit_plan_owner()  -- plan_versions:     new.owner_id := (select owner_id from public.plans where id = new.plan_id)
```
`security definer set search_path = ''`, execute revoked from everyone (trigger-only). RLS `with check` runs after `before` triggers, so a stranger's insert gets the real owner's id and then fails the policy (42501). An unknown parent leaves `owner_id` null and fails `not null`.

Trigger names: `plans_00_inherit_owner`, `trip_items_00_inherit_owner`, `plan_versions_00_inherit_owner`. Same-event triggers fire in name order, and `plan_versions_assign_no` needs the final `owner_id` (it updates `plans … where owner_id = new.owner_id`). pgTAP checks the order.

### 2.5 Owner-only columns and the purpose reference on `trips` **[D3] [D5] [D10]**

- **Trigger, not column grants.** Owner and grantee are both the `authenticated` role, so a column grant cannot tell them apart. `private.trips_owner_only()` `before update on trips`: when `(select auth.uid()) is not null and (select auth.uid()) <> old.owner_id` and any of `group_id, group_text, group_structure, purpose_id` is distinct from `old`, raise `'owner_only' using errcode = '42501'`. A null `auth.uid()` (secret key, for example the `group_parsed` cache write) passes. Holds for every path, also direct PostgREST calls.
- **Purpose reference.** Drop the composite FK `(purpose_id, owner_id) → trip_purposes` and add `foreign key (purpose_id) references public.trip_purposes (id) on delete set null`. `private.trips_check_purpose()` `before insert or update of purpose_id`: a non-null `purpose_id` must belong to `new.owner_id` or be in `purpose_shares` with `grantee_id = new.owner_id`; otherwise raise `using errcode = '23503'` (`trips.ts` already maps 23503 to `not_found`).
- **Unshare or leave a purpose.** `private.purpose_share_removed()` `after delete on purpose_shares` (definer): `update public.trips set purpose_id = null where owner_id = old.grantee_id and purpose_id = old.purpose_id`. Those trips get a new `updated_at`, so their plans show as outdated; plan versions keep their snapshot.
- `group_id` keeps its composite FK: groups are not shareable.

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
Both `security definer set search_path = ''`, email compared with `lower()` on `auth.users.email`. `share_contacts` returns only counterparts of the caller's own share rows, so it reveals nothing the caller has not already been given.

### 2.8 Admin aggregate

`public.admin_share_stats(p_month_start timestamptz) returns jsonb`, service_role only, counts only: `tripSharesRead`, `tripSharesWrite`, `purposeSharesRead`, `purposeSharesWrite`, `tripsShared` (distinct trips), `recipients` (distinct grantees), `grantsThisMonth`, `lookupsThisMonth`, `lookupMissesThisMonth` (from `app_events`). No ids, emails or titles.

---

## 3. Server (backend-dev)

### 3.1 Domain `src/lib/domain/sharing.ts`

```ts
export const SHARE_ACCESS = ["read", "write"] as const;
export type ShareAccess = (typeof SHARE_ACCESS)[number];
export type Access = "owner" | ShareAccess;
export const SHARE_RESOURCES = ["trip", "purpose"] as const;
export type ShareResource = (typeof SHARE_RESOURCES)[number];
export const MAX_SHARES_PER_RESOURCE = 10;
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
- `Trip` and `TripPurpose` gain `access: Access` and `ownerId: string`; `TripSummary` gains `access`, `sharedBy: Person | null` (incoming) and `shareCount: number` (own trips). `TRIP_COLUMNS` and `PURPOSE_COLUMNS` add `owner_id`; access = `owner_id === session.userId ? "owner" : <share row access>`.
- `result.ts` gains `no_account` (share by email: no usable account), `self_share`, and `forbidden` is widened to "not allowed for this user" (admin and owner-only actions).

### 3.2 Actions `src/lib/server/sharing.ts` ("use server")

One module for both resources (a table map `{ trip: "trip_shares", purpose: "purpose_shares" }`). All writes use the user session, so RLS checks every rule a second time.

| Action | Steps |
|---|---|
| `listGrants(resource, id)` | session → owner check via RLS read of the resource (`owner_id = me`, else `forbidden`) → share rows → `share_contacts()` for names and emails |
| `shareWith(input)` | session (401) → Zod → profile: demo → `demo_forbidden` → resource read via RLS, owner only (`forbidden`) → resolve target (3.3) → self → `self_share` → count `>= 10` → `limit_reached` → insert; on 23505 (already shared) update `access` instead and send no mail → mail (3.4) → event |
| `setShareAccess(input)` | owner update through RLS; 0 rows → `not_found`; no mail |
| `unshare(input)` | owner delete through RLS; 0 rows → `not_found` |
| `leaveShare(input)` | delete `where id = :id and grantee_id = me`; 0 rows → `not_found` |
| `listSharedWithMe()` | `trip_shares` and `purpose_shares` where `grantee_id = me`, embedded resource summary, `share_contacts()`; two queries in parallel |
| `listShareCandidates()` | admin only (`getAdminSession`): users from the Auth admin API and `profiles` with the secret key, minus self, demo and disabled; email and display name only |

Events (`app_events`, ids and flags only; never emails, names or titles) **[D12]**: `sharing.granted { resource, resourceId, access, via: "email" | "list", mailed }`, `sharing.access_changed { resource, resourceId, access }`, `sharing.revoked { resource, resourceId }`, `sharing.left { resource, resourceId }`, `sharing.lookup { found }`, `sharing.mail_failed { resource, code }` (warn). The `sharing.` prefix keeps them apart from the link events `share.*`.

### 3.3 Finding the recipient **[D13] [D14]**

- Owner (not admin): only `{ email }` is accepted. Limits, checked before the lookup: in memory `share-lookup:{userId}` 5 per minute, and durable `SHARE_LOOKUPS_PER_DAY` = 20 per Berlin day, counted as `sharing.lookup` rows of this user since `berlinMidnight()` (secret key, `count: "exact", head: true`). The durable count is needed because in-memory limits are per instance. Every lookup writes `sharing.lookup`, hit or miss, before the answer.
- `rpc("share_user_by_email")` with the secret key. null → `no_account`; the UI says "No account with this email. The app is invite-only: ask the admin to invite them." This reveals whether an email has an account (accepted by Alex). Demo and disabled accounts answer like unknown ones.
- Admin: the form shows the user list only, no email field (Alex). `{ userId }` from `listShareCandidates()` is checked again against self and, through the insert policy, with `can_receive_share`. No lookup limit, no `sharing.lookup` row.
- `{ userId }` from a non-admin → `forbidden`.

### 3.4 Email to the recipient **[D15]**

- Sent after a new share (not on an access change or a repeat), in the recipient's `profiles.locale`, best effort: a failure leaves the share in place, logs `sharing.mail_failed`, and the action answers `{ ok: true, data: { mailed: false } }`; the dialog then says "Shared. The email could not be sent."
- The invite mail goes through Supabase Auth (`inviteUserByEmail`), which only mails people without an account. Supabase has no API for a plain notice to an existing user. So the notice uses the same provider and sender behind that SMTP: Brevo's transactional API (`POST https://api.brevo.com/v3/smtp/email`, header `api-key`), new server secret `BREVO_API_KEY`, sender `MAIL_FROM` (= the current SMTP sender). No key → no mail, `mailed: false`, event code `not_configured`. Each call is logged in `api_calls` (provider `brevo`, no address).
- Content (strings in `sharing.mail.*`, both locales): subject "{owner} shared a trip with you" / "… a trip purpose …"; body with the trip title (or destination) or purpose name, the level ("you can view it" / "you can view and edit it"), one button to `/{locale}/app/trips/{id}` or `/{locale}/app/purposes/{id}`, and a footer "You get this email because someone shared something with you in Travel Planner." Owner = display name, else the owner's email. HTML in the Atlas style of `docs/email-templates/`, every value escaped; plain-text part too.
- Files: `src/lib/integrations/brevo.ts` (typed client, Zod on the response), `src/lib/server/mail/share-notice.ts` (builds subject, HTML, text from `getTranslations({ locale, namespace: "sharing.mail" })`).

### 3.5 Changes to existing server code **[D16]**

RLS now returns more rows than "my own" in a few places. Every list that means "mine" must filter by owner explicitly.

| File | Change |
|---|---|
| `trips.ts` `listTrips` | `.eq("owner_id", userId)` and `trip_shares(count)` for `shareCount`; shared trips come from `listSharedWithMe` |
| `trips.ts` `createTrip` | trip cap count gets `.eq("owner_id", userId)` (shared trips do not count) |
| `trips.ts` `updateTrip` | non-owner: the write keeps the stored `group_id, group_text, group_structure, purpose_id` (the trigger rejects a change; 42501 → `forbidden`). New argument `expectedUpdatedAt`: update `.eq("updated_at", expectedUpdatedAt)`; 0 rows on an existing trip → `conflict` (3.6) |
| `trips.ts` `deleteTrip` | unchanged (RLS: owner only; a grantee gets `not_found`) |
| `purposes.ts` `listPurposes` | `.eq("owner_id", userId)`; the trip form's purpose select adds shared purposes from `listSharedWithMe` |
| `purposes.ts` `updatePurpose` | `expectedUpdatedAt` as for trips; `deletePurpose` unchanged |
| `groups.ts` `listGroups` | `.eq("owner_id", userId)` (groups of shared trips are readable now) |
| `plan-store.ts` `hasBusyPlan(sb, userId)` | `.eq("busy_by", userId)`: the in-flight guard counts the actor's own runs, not a run someone else started on a shared plan |
| `plan-store.ts` `pruneVersions` | `rpc("prune_plan_versions", { p_plan_id })` instead of a delete |
| `plan-store.ts` `savePurposeTags`, `group-text.ts` `saveGroupParse` | take the row's `ownerId` (read through RLS before) instead of the actor's id for the `owner_id` filter; the AI call stays charged to the actor |
| `plan-pipeline.ts` `loadPlanContext` | adds `access`, `ownerId`; for a non-owner reads the owner's `birthdate, home_airports, locale, display_name` with the secret key (one explicit select by `trip.ownerId`) and uses them for `birthdate` / `homeAirports` (1.2). `read` access → `forbidden` for every write path (`generatePlan`, `iteratePlan`, `editPlanVersion`, `restoreVersion`, `toggleOpenItem`). Locale for a non-owner: latest version's `plan.locale`, else the owner's |
| `plan-document.ts` `getOwnerPlanDocument` | allowed for `owner` and `write`; `read` → `forbidden` (PDF route 403) |
| `items.ts` | write actions check `access !== "read"` before the write (clear error instead of an RLS 0-row miss) |
| trip page reads (`trip-page-reads.test.ts`) | one more parallel read for the share badge (`trip_shares` row of the viewer or the grant count); the round count may stay at 7 if it joins an existing round |
| `account.ts` / `user-removal.ts` | no code change; cascades in 3.7 |

Group and purpose readers (`getGroup`, `getPurpose`) need no change: RLS lets the grantee read exactly the ones attached to the shared trip.

### 3.6 Two editors at once **[D17]**

- Plan: unchanged rules. The generation lock (`busy_until`) is per plan, so a second generation answers `busy` and the page shows the watching state; with `busy_by` not the viewer it adds "{name} is updating the plan". Iterate, edit and restore carry `baseVersion` and answer `conflict` when someone else added a version; the UI reloads the plan state and says "The plan was changed by someone else. Have a look at the new version and try again."
- Trip and purpose forms: optimistic check on `updated_at` (3.5); `conflict` → "Someone else changed this in the meantime. Reload to see the changes." Owners editing alone see no difference.
- Items and open-item ticks: last write wins (small rows, no merge). Accepted.
- No live updates: the other person sees changes on reload or the next poll that already runs while busy.

### 3.7 Account deletion, disable, retention **[D18]**

- Owner deleted: their trips and purposes cascade, and with them all shares; recipients lose them silently. A grantee's trips that used the owner's purpose keep the trip, `purpose_id` set null (FK).
- Grantee deleted: their share rows cascade; `plans.busy_by` and `plan_versions.created_by` become null; versions they created stay with the owner's plan.
- The delete-account dialog adds one line: "Trips and purposes you shared are removed for the people you shared them with. Things shared with you stay with their owners."
- Disabled owner: shares hidden (2.2). Disabled grantee: signed out; shares stay until an admin deletes the account.
- Retention unchanged: a share does not keep a trip alive; a grantee's edits do, because they update the same `trips`, `plans` and `trip_items` rows the purge reads.
- Demo reset: nothing to do (demo has no share rows); trips cascade as before.

---

## 4. UI (frontend-dev)

### 4.1 Share box on the trip page and on the purpose page (owner only) **[D19]**
- Trip: a "People" block at the top of the existing `SharePanel` (links stay below, unchanged). Purpose: the same block on `/app/purposes/[id]`. Component `src/components/sharing/people-share.tsx` (client) with `grant-row.tsx`.
- Add form: email input (`type="email"`, `autocomplete="off"`), access as two chips in `grid-cols-2` ("Can view" | "Can edit"), button "Share". Admin: a native `<select>` of `listShareCandidates()` (email, name in brackets) instead of the input.
- Notice above the button, always visible on trips: "They will see the whole trip, including the travel group with names and birthdates." On purposes: "They can use this purpose for their own trips. People they share those trips with can see it there."
- Rows: name or email (truncated, full value in `title`), the email in small text below when a name is shown, access select, remove button (`ConfirmDialog`). "Shared with {n} of 10".
- States: `no_account`, `self_share`, `limit_reached`, `rate_limited`, `demo_forbidden` (block disabled with `sharing.demoDisabled`), mail failed.
- 360 px: input, chips and button stacked full width, rows wrap name above controls, touch targets `min-h-11`, no horizontal scroll. From `sm`: input and button in one row.

### 4.2 Lists
- `/app` trips column: own trips as today, a small "Shared · {n}" pill on cards with grants. Below them a section "Shared with me" (hidden when empty) with the same cards plus a badge "{name} · Can view" or "{name} · Can edit". Same on the purposes column and `/app/purposes`.
- Badge `src/components/sharing/share-badge.tsx`: text label always present (colour is not the only signal), wraps under the title at 360 px.

### 4.3 Shared trip or purpose page (recipient)
- Header badge as in the list plus "Leave" (`ConfirmDialog`: "You lose access. {name} keeps the trip."), then redirect to `/app`.
- Read: plan view in read-only mode (the `readOnly` props from phase 5: no iterate chips, no edits, no open-item ticks, no regenerate), items `readOnly`, no PDF button, no share panel, no "Back to suggestions", no edit or delete buttons.
- Write: everything except delete, share panel and "Back to suggestions". The trip form shows group and purpose as read-only text with the note "Only {name} can change the group and purpose." The plan view shows "by {name}" on versions created by someone else.
- Group block: read-only list of all entries; the `is_self` entry shows the owner's name and age.
- Purpose on a shared trip: name and text read-only; a link to the purpose only when it is also shared with the viewer.

### 4.4 Trip form for own trips
The purpose select lists own purposes, then "Shared with me" purposes (optgroup) with the owner's name.

### 4.5 i18n (de + en, same keys) **[D20]**
`sharing.{title, people, intro, email, emailPlaceholder, pickUser, add, adding, count, groupNotice, purposeNotice, access.{read, write}, remove, confirmRemove, changeAccess, demoDisabled, mailFailed, sharedPill, sharedWithMe, badge, leave, confirmLeave, ownerOnly, ownerOnlyContext, by, busyBy, conflictPlan, conflictForm, errors.{no_account, self_share, limit_reached, rate_limited, forbidden, failed}, mail.{subjectTrip, subjectPurpose, intro, bodyTrip, bodyPurpose, levelRead, levelWrite, open, footer}}`, `settings.deleteAccount.sharedNote`, `admin.usage.{tripShares, purposeShares, tripsShared, recipients, grantsThisMonth, lookups, lookupMisses}`.

### 4.6 Admin page
"Usage" section gets one row of share counts from `admin_share_stats` (2.8). Nothing per user.

---

## 5. Tests

pgTAP (`supabase/tests/sharing.test.sql`, new file; actors A owner, B write grantee, C read grantee, D stranger, E demo, F disabled owner):
- `trip_shares` / `purpose_shares`: A inserts for own trip; A cannot share B's trip (23503); self-share rejected (check); share to E rejected (policy); E cannot insert any share; duplicate grantee 23505; B sees own incoming row, D sees none; only A updates `access`; B and C can delete their own row (leave), D cannot; anon nothing.
- Visibility: B and C see A's shared trip, its plan, versions, items, group, entries and purpose; D sees none; B's and C's own lists (`where owner_id = auth.uid()`) do not contain them; A's other trips and groups stay invisible to B; after unshare B sees nothing; F's shares are invisible.
- Writes: B updates trip fields, inserts plan, plan version (gets `version_no`, `owner_id = A`, `created_by = B`), items, updates `busy_until` (`busy_by = B`) and `open_done`; C gets 42501 / 0 rows for each; B cannot delete the trip, the plan, versions, share links, groups or purposes; B cannot change `group_id`, `group_text`, `group_structure`, `purpose_id` (42501); the secret key (no `auth.uid()`) can still write `group_parsed`.
- `plan_versions_00_inherit_owner` fires before `plan_versions_assign_no` (insert by B succeeds).
- `prune_plan_versions`: B prunes only beyond 30; C and D get 42501.
- Purposes: B (write share) updates name/text, not `parsed_*`; C cannot; B attaches A's shared purpose to B's own trip; D cannot (23503); after A unshares, B's trip has `purpose_id` null; A deleting the purpose clears it too.
- `share_user_by_email` not executable by `authenticated`; returns null for E and F. `share_contacts` returns only counterparts.
- Cascades: deleting A removes the shares; deleting B nulls `busy_by` and `created_by`.

Unit (Vitest, next to the code):
- `domain/sharing.test.ts`: Zod email normalisation, target union, limits.
- `server/sharing.test.ts` (mocked clients): demo → `demo_forbidden`; non-owner → `forbidden`; unknown email → `no_account` and a `sharing.lookup { found: false }` event; 21st lookup of the day → `rate_limited`; `userId` from a non-admin → `forbidden`; self → `self_share`; 10 grants → `limit_reached`; repeat share updates access and sends no mail; mail failure → `mailed: false`, share kept; events contain no email, name or title.
- `server/mail/share-notice.test.ts`: de/en subjects, escaping, link per resource, fallback to email without a display name.
- `integrations/brevo.test.ts`: request shape against a recorded response, no key → not configured.
- `plan-pipeline.test.ts`: write grantee uses owner birthdate, home airports and plan locale (same input hash as the owner); read grantee → `forbidden`; AI usage logged with the actor's id; `hasBusyPlan` ignores a lock held by someone else.
- `trips.test.ts` / `purposes.test.ts`: own lists filter by owner; cap counts own trips only; stale `expectedUpdatedAt` → `conflict`; grantee update keeps group and purpose.
- `plan-store.test.ts`: prune calls the RPC; `MAX_VERSIONS_KEPT` equals the SQL constant.

E2E outline (Playwright, mobile and desktop, users from `phase-6-e2e.md` plus a second user):
1. A shares a trip with B (write) by email; B sees it under "Shared with me" with the badge, edits the length, regenerates; A sees the new version "by B".
2. A changes B to read; B sees no edit controls and no PDF button; the plan form is gone.
3. A shares a purpose with B; B picks it in the trip form of a new own trip; A unshares; B's trip shows no purpose.
4. B leaves; the trip is gone from B's list.
5. Unknown email shows the invite-only message; demo login sees the share block disabled.
6. 360 px screenshots of the share box, a badge card and the shared trip header.

---

## 6. Delivery split

| PR | Owner | Content | Depends on |
|---|---|---|---|
| 1 | backend-dev | migration 35 (section 2), `supabase/tests/sharing.test.sql`, header range update in `rls.test.sql`; existing pgTAP that expected 23503 for an item on another user's trip now expects 42501 | – |
| 2 | backend-dev | `domain/sharing.ts`, `result.ts`, `server/sharing.ts`, mail (`integrations/brevo.ts`, `server/mail/share-notice.ts`), all changes of 3.5 and 3.6, admin stats reader, `sharing.mail.*` keys (de + en), `.env.example` (`BREVO_API_KEY`, `MAIL_FROM`), runbook note (key rotation, Brevo daily limit), unit tests | PR 1 deployed |
| 3 | frontend-dev | section 4, remaining i18n keys, E2E | PR 2 |

Deploy order: the migration is safe for the current app. No share rows exist until PR 2, so the missing owner filters cannot show anything extra; the purpose FK change accepts every existing row; the old `pruneVersions` delete still works for owners. PR 2 must add the owner filters before (or in the same deploy as) the first action that creates shares.

---

## 7. CLAUDE.md ground rule 6

Proposed wording, to be applied by the orchestrator with Alex's approval (the architect writes only under `docs/`):

> 6. **Users see only their own data.** Every user table has `owner_id` with an RLS policy `owner_id = auth.uid()`. Exception: a trip or trip purpose the owner shared with a named user (`trip_shares`, `purpose_shares`) is also visible to that user, read-only or read/write, through `private.*` helper functions; a shared trip shows its group and purpose read-only (`docs/specs/sharing.md`). Public share links are read through a server route by token only. Secrets stay server-side (never `NEXT_PUBLIC_`).

The change from "Shared plans" to "Public share links" avoids a contradiction with direct shares.

---

## 8. Files

| Area | Files |
|---|---|
| DB | `supabase/migrations/20261110120035_sharing.sql`, `supabase/tests/sharing.test.sql`, `supabase/tests/rls.test.sql` (header, one expectation) |
| Domain | `src/lib/domain/sharing.ts` (new), `result.ts`, `trip.ts`, `purpose.ts` |
| Server | `src/lib/server/sharing.ts` (new), `src/lib/server/mail/share-notice.ts` (new), `src/lib/integrations/brevo.ts` (new), `trips.ts`, `trip-mapping.ts`, `purposes.ts`, `purpose-insert.ts`, `groups.ts`, `plan-store.ts`, `plan-pipeline.ts`, `plan-document.ts`, `items.ts`, `group-text.ts`, `purpose-tagging.ts`, `admin/stats.ts` |
| UI | `src/components/sharing/{people-share,grant-row,share-badge,leave-button}.tsx` (new), `src/components/share/share-panel.tsx`, trip list and purpose list components, trip page, purpose page, trip form, plan view (`readOnly`, "by"), settings delete dialog, admin usage section |
| i18n | `messages/de.json`, `messages/en.json` |
| Docs | `CLAUDE.md` rule 6 (section 7), `docs/runbook.md` (Brevo key), `docs/architecture.md` isolation line |

---

## 9. Risks
- The new policies widen seven tables (`trips`, `plans`, `plan_versions`, `trip_items`, `travel_groups`, `group_entries`, `trip_purposes`). A missing owner filter shows someone else's shared item in a "mine" list. Section 3.5 lists every known place; the pgTAP "own list" checks and a review grep for unfiltered `from("trips")`, `from("trip_purposes")`, `from("travel_groups")` guard it.
- Account enumeration: 20 lookups a day per user, invite-only app, so the exposure is small and logged (`lookupMissesThisMonth` on the admin page).
- Brevo free tier: 300 emails a day; at 20 lookups a day per owner this is far away.
- Transitive purpose visibility (2.2, `shared_purpose_ids` includes purposes on trips shared with me, whoever owns the purpose). Needed so a write grantee's regeneration keeps the purpose; stated in the purpose share notice.

---

## 10. Later: sharing groups (not in scope)
Groups are not shareable yet (Alex). Open problem for that step: the person you share with may already be a hand-entered member of your group ("Ben" with a typed birthdate). Linking that entry to Ben's account would let his own birthdate replace the typed one and show him "you" in the group, but there is no safe way to match a typed name to an account: names are not unique, and matching by email needs an email the member entry does not have. A future spec should let the owner link an entry to a grantee explicitly, and let the grantee confirm it, instead of guessing.

---

## 11. Decisions
- **[D1] (Alex)** Scope: trips (with plan, versions, items) and trip purposes. Groups later. Live access, no copies. Two levels, `read` and `write`.
- **[D2] (Alex)** Write allows editing trip fields, generating and patching the plan, items, PDF. Owner only: delete, share and unshare, share links, the group. Recipient can leave. Shown under "Shared with me" with owner and level. Group on a shared trip fully visible (names, birthdates), read-only; the share box says so. Purpose on a shared trip read-only; editing or own use needs a purpose share. AI costs go to the acting user. Email to the recipient in their locale. Demo neither shares nor receives. Owner types an existing user's email, success only for existing accounts (enumeration accepted, rate-limited); admins pick from a list of all users except demo.
- **[D3]** `purpose_id` on a shared trip is owner-only, like `group_id` (Alex); the trip's one-off group (`group_text`, `group_structure`) counts as "the group" and is owner-only too.
- **[D4]** The `is_self` entry is shown to recipients as the owner's name and computed age, without the owner's profile birthdate: that birthdate belongs to the profile, not the group.
- **[D5]** A purpose share at either level allows picking it for own trips; `write` also allows editing. The trips → purposes FK becomes a plain FK plus a trigger (same owner or shared with the trip owner). Unshare and leave clear the reference.
- **[D6]** Plans on shared trips use the owner's birthdate, home airports and plan locale, so the hash and language do not depend on who presses the button.
- **[D7]** Two access tables, `trip_shares` and `purpose_shares`, instead of one polymorphic table: real FKs with cascades on the resource and on both users, simple unique keys.
- **[D8]** RLS through `security definer` helpers returning id arrays, called once per statement; disabled owners' shares are hidden.
- **[D9]** Child rows written by a grantee take the parent's `owner_id` in a `before insert` trigger, so composite FKs and owner-based code stay valid.
- **[D10]** Owner-only trip columns are guarded by a trigger, not column grants (both users are `authenticated`).
- **[D11]** `plans.busy_by` for a per-actor in-flight guard; `plan_versions.created_by` for "by {name}"; pruning through a definer RPC so grantees cannot delete versions directly.
- **[D12]** Events under `sharing.*`, ids and flags only.
- **[D13]** Lookup limit 5 a minute in memory plus 20 a Berlin day counted from `app_events`, every lookup logged.
- **[D14]** Demo and disabled accounts answer like unknown emails.
- **[D15]** The notice email uses Brevo's transactional API with the existing sender (Supabase Auth cannot mail existing users); best effort, no mail on access changes. The trip title or purpose name is in the mail.
- **[D16]** "Mine" lists filter by `owner_id` explicitly; cache writes use the row owner's id.
- **[D17]** Concurrent editing: existing plan lock and `baseVersion` conflicts; optimistic `updated_at` check on trip and purpose forms; last write wins for items and open-item ticks.
- **[D18]** Deletion and retention by cascade; a share does not extend retention.
- **[D19]** Share box inside the existing share panel and on the purpose page; badges and "Shared with me" sections on the existing lists.
- **[D20]** New i18n namespace `sharing` (the `share` namespace stays for links).
