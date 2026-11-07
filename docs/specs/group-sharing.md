# Spec: share travel groups between users (issue #129, follow-up of #82)

Status: accepted (Alex, 2026-11-07). Decisions marked "(Alex)" were made by Alex, including his answers of 2026-11-07 to the former open questions; the others are architect calls, accepted with the spec. All decisions are listed as **[G#]** in section 11.
Decisions and reasons: `docs/adr/0011-sharing-groups.md`. Builds on `docs/specs/sharing.md` (decisions D1 to D26); everything there applies unless this spec says otherwise. Conventions unchanged: private schema, explicit grants, `(select auth.uid())`, init-plan policy calls `x = any ((select private.f()))`, `share_resource` as the only write path for grants, disabled owner hidden on every recipient path, demo excluded, snake_case DB / camelCase TS, `ActionResult`, `logEvent` metadata only.

Scope: an owner gives another existing user live access to one travel group (name, notes, group text, trait keys, all entries), read-only or read/write. The recipient finds it under "Shared with me", can leave it, and can use it for their own trips and destination searches. Any recipient who can see a group can mark one named entry as themselves ("That's me"). Shared trips show birthdates of all entries, including the owner's (closes #129).
Not in scope: sharing a trip's one-off group text (`trips.group_text`, it lives on the trip and is shared with the trip), notifications (no email, Alex), copies, merging two groups, owner confirmation of a link.

---

## 1. Model

### 1.1 Access levels **[G1] [G2]**

| Action on a group | Owner | Write | Read |
|---|---|---|---|
| See name, notes, group text, trait keys, all entries with names and birthdates, the owner's `is_self` entry with the owner's name and profile birthdate | yes | yes | yes |
| Use it for own trips and own destination searches | yes | yes | yes |
| Edit name, notes, group text (`description`), trait keys | yes | yes | no |
| Add, edit, reorder entries; delete entries that are not `is_self` and not linked to someone else | yes | yes | no |
| Edit label, notes and traits of the owner's `is_self` entry | yes | yes | no |
| Set or move `is_self`; add or delete the `is_self` entry | yes | no | no |
| Delete an entry linked to another user | yes | only the linked user | no |
| "That's me" on an eligible entry (1.3), undo own link | – | yes | yes |
| Remove anyone's link | yes | no | no |
| Delete the group, share / unshare, change access | yes | no | no |
| Leave the share | – | yes | yes |

- Two levels `read` and `write`, live access, cap 10 grantees per group, demo neither shares nor receives, no notification email, AI costs (Haiku group-text parse) charged to the acting user (all Alex, same as D1, D2, D15).
- Listed under "Shared with me" on `/app` and `/app/groups` with the owner's name and level (Alex).
- Write grantees may edit label, notes and traits (diet, mobility) of the owner's `is_self` entry (Alex) **[G21]**.
- A group reached only through a shared trip (sharing.md 2.2 `shared_group_ids`) has access `read` and `usable: false`: visible on that trip, not pickable for own trips or searches, not editable. This mirrors purposes (D5) **[G3]**. "That's me" is still offered there (1.3).

### 1.2 What recipients see **[G4] [G5]**

- All entries with names and birthdates (Alex), for group shares and for shared trips alike.
- **Decision A (Alex):** the owner's `is_self` entry is shown to recipients as the owner's display name **with the owner's profile birthdate** (and the computed age). This reverses sharing.md D4 for shared groups and for shared trips. The owner's birthdate leaves the server only when the group has an `is_self` entry; a group without one sends at most the owner's age (needed for "about my age", 1.4). Nothing else of the owner's profile (home airports, locale, home location, email beyond `share_contacts`) reaches the client.
- **Shared trips show birthdates of all entries (Alex, closes #129):** the group block on a shared trip lists each member's birthdate next to the age, as the share notice already promises. `birthdateForAge` stand-ins disappear from the trip page (4.4).
- Transitive visibility (Alex, accepted): a group used on a trip that is shared with you is visible on that trip, read-only, whoever owns the group, while the group owner is active. Example: B uses A's shared group on B's trip and shares that trip with C; C sees A's group with names and birthdates, including A's. The group share notice says so.
- Labels are relative to the viewer (1.5). Link state of the other entries (Alex): the group owner sees "{name} ✓", every other viewer sees "✓ Linked" without a name. The raw `linked_user_id` uuid is readable through RLS like every other column; it carries no name or email (risk 10).

### 1.3 "That's me" (entry links) **[G6] [G7] [G8] [G9]**

- Who (Alex): any recipient who can see the group, through a **group share** at either level or through **any shared trip that uses the group**, whoever owns that trip (also another recipient's trip). In SQL: the group is in `private.shared_group_ids()`.
- What (Alex): an entry with `kind = 'member'`, `is_self = false`, `linked_user_id is null`. Effective immediately, no owner confirmation. One link per entry (column).
- **One entry per user per group (Alex):** while a user has a link in a group, "That's me" is not offered on any other entry of that group. To switch they first undo ("That's not me"). The server refuses a second claim (`already_claimed`); there is no move.
- Undo (Alex): the linked user says "That's not me"; the owner can remove any link. After a removal the user can link again right away (Alex, no block).
- Only through `public.claim_group_entry` / `public.unclaim_group_entry` (2.6): no column grant on `linked_user_id`, the functions never change any other field. Write grantees can neither set nor clear links for others, nor flip `is_self` (Alex), enforced by the guard trigger (2.5). Only the owner and the linked user may delete a linked entry (Alex).
- Label only (decision B, Alex): the linked user's profile birthdate never replaces the typed birthdate or age. A write grantee (including the linked user) edits the typed data like any other field. The only place a link changes a computed value is "about my age" (and the plan's `"self"` label) on the linked user's own trips (1.4), and there the entry's typed data wins.
- Cleared when the linked user has **no route to the group left** (Alex): no group share and no trip share of any trip that uses the group. Routes end when a group share is revoked or left, a trip share is revoked or left, a trip is deleted, a trip's `group_id` changes (by its owner, or cleared because its owner lost their group share), or the account is deleted. A disabled group or trip owner only hides; links stay (2.8).

### 1.4 Whose age: `is_self` and "about my age" **[G10] [G11]**

Today one profile birthdate serves both `is_self` and `relativeToMe` (sharing.md 1.2: the trip owner's). With shared groups the trip owner `T` and the group owner `G` can differ. Rules, identical for the plan pipeline, the trip page, the group page preview and destination searches (`T` = the search owner there):

| Case | `is_self` entry | `relativeToMe` ("about my age", entries and parsed travellers) | Plan label `"self"` |
|---|---|---|---|
| `T = G` (every trip today) | `G`'s profile birthdate | `T`'s profile birthdate | on the `is_self` row (unchanged) |
| `T ≠ G`, `T` linked to entry `X` of the group | `G`'s profile birthdate | age of `X`: its birthdate, else its stated age (advanced by `age_as_of`), else `T`'s profile birthdate | on `X` when `X` has no label of its own; the `is_self` row gets none |
| `T ≠ G`, no link | `G`'s profile birthdate | `G`'s profile birthdate | nowhere |

- `relativeToMe` refers to the group owner until the trip owner said "That's me", then to the trip owner (Alex). "The trip owner's age" = the linked entry's age (typed birthdate or stated age), falling back to `T`'s profile birthdate only when the entry has no age data of its own or is itself `relativeToMe` (Alex). A typed birthdate is never overridden (decision B).
- On a recipient's own trip the `is_self` entry is a traveller named with `G`'s display name, `G`'s birthdate and age; in the plan input it has no `"self"` label, because the plan addresses `T` (Alex).
- The actor never matters (extends D6): a write grantee of `T`'s trip gets the same anchors, so the same input gives the same hash. All three inputs come from rows: `T`'s profile (owner context, sharing.md 1.2), `G`'s profile birthdate (read with the secret key **after** the group was read through RLS) and the link state on the entries. `G`'s birthdate is read only when `G ≠ T`.
- Every existing trip has `T = G`, so no existing plan input or hash changes (eval E10 stays green).
- Linking or unlinking marks only the linked user's own trips that use the group as outdated, never the owner's (Alex) **[G22]**.

### 1.5 Labels per viewer (example) **[G23]**

"Me" always means the viewer's own entry: for the group owner the `is_self` entry, for a recipient the entry they claimed. Example: group of two, `A` (owner, `is_self`) and a typed entry "B". A shares the group with B; B says "That's me" on entry "B".

| Where | Viewer A | Viewer B | Viewer C (another recipient) |
|---|---|---|---|
| Group page / group block | A's entry: "You" (`groups.preview.me` as today); entry "B": "B ✓" (`{name}` = B's display name from `share_contacts`) | A's entry: A's display name (`sharing.groupBlock.groupOwner`) with birthdate; entry "B": "You" with "That's not me" | A's entry: A's display name; entry "B": typed name "B" with "✓ Linked" |
| A's trip with the group, shared with B and C | same as above | same as above | same as above |
| Plan of **A's** trip (`T = A`) | `"self"` on A's entry; `relativeToMe` = A | (viewing A's plan: content is A's, unchanged) | (same) |
| Plan of **B's** own trip with the group (`T = B`) | (A cannot see it unless B shares it) | `"self"` on entry "B" (it has no label); A's entry is a plain traveller; `relativeToMe` = age of entry "B", fallback B's profile birthdate | (if B shares the trip with C) same plan content |

- Display labels ("You", name, "✓") depend on the **viewer**. Computed values (ages for `relativeToMe`, the plan's `"self"` label) depend on the **trip owner** `T`, never on the viewer or the actor, so a plan and its hash look the same to everyone who sees that trip. On A's trip, B sees "You" on entry "B" and A's name on A's entry, while the ages and plan stay A's.
- Before B claims: B sees entry "B" with "That's me"; A sees the typed "B" without a mark; on B's own trips `relativeToMe` refers to A.
- The group page preview for a recipient uses the rule of their own trips (Alex) **[G24]**: "about my age" = the viewer's claimed entry, else the group owner ("about {name}'s age").
- A viewer who has claimed an entry sees no "That's me" button on other entries (1.3).

### 1.6 Using a shared group for own trips and searches **[G12] [G13]**

- A recipient (either level, Alex) may pick a shared group for their own trips and their own destination searches, like shared purposes (D5, D21). `trips.group_id` and `destination_searches.group_id` lose the composite same-owner FK and get a plain FK plus a usable-by trigger (2.7).
- Unshare or leave: the recipient's own trips and searches lose the reference (`group_id = null`); trips get a new `updated_at`, so their plans show as outdated; plan versions keep their snapshot; a search keeps its cards. Links that relied on those trips (people the recipient shared them with) are cleared when no other route is left (2.8).
- `group_id` on someone else's shared trip stays owner-only (D3, `trips_00_owner_only`), whatever group shares the write grantee has.

---

## 2. Migration `supabase/migrations/20261112120037_group_sharing.sql` (forward-only, additive)

### 2.1 `group_shares` **[G14]**

Same shape as `trip_shares` (sharing.md 2.1):

| Column | Type | Null | Default | Check / note |
|---|---|---|---|---|
| `id` | uuid | no | `gen_random_uuid()` | PK |
| `owner_id` | uuid | no | | FK `auth.users` on delete cascade; set by `share_resource` |
| `group_id` | uuid | no | | composite FK `(group_id, owner_id) → travel_groups (id, owner_id)` on delete cascade |
| `grantee_id` | uuid | no | | FK `auth.users` on delete cascade; `check (grantee_id <> owner_id)` |
| `access` | text | no | `'read'` | `in ('read','write')` |
| `created_at`, `updated_at` | timestamptz | no | `now()` | `private.set_updated_at()` trigger |

- `unique (group_id, grantee_id)`; indexes `(grantee_id, created_at desc)` and `(owner_id)`.
- Grants: `revoke all … from anon, authenticated, public; grant select, delete … to authenticated`. No insert or update grant (D24).
- Policies: select `(select auth.uid()) = owner_id or ((select auth.uid()) = grantee_id and (select private.is_active(owner_id)))`; delete owner or grantee. No insert or update policy.

### 2.2 Helper functions (all `language sql stable security definer set search_path = ''`)

```sql
-- REDEFINED (create or replace, same signature): group shares to me, plus groups of trips shared with me; both only while
-- the GROUP owner is active (the trip branch now needs its own check: a trip owner can use someone else's group).
-- Also the set of groups where "That's me" is allowed (1.3).
private.shared_group_ids() returns uuid[]
  -- group_shares where grantee_id = auth.uid() and is_active(owner_id)
  -- ∪ trips.group_id of shared_trip_ids() joined travel_groups g where is_active(g.owner_id)
private.writable_group_ids() returns uuid[]   -- group_shares to me with access = 'write' and is_active(owner_id)
private.group_usable_by(p_group uuid, p_user uuid) returns boolean
  -- p_group belongs to p_user, or group_shares has (p_group, grantee p_user) and is_active(owner_id)
private.group_reachable(p_group uuid, p_user uuid) returns boolean
  -- link pruning (2.8): does p_user still have ANY route to p_group? NO is_active check (a disabled owner only hides):
  -- exists group_shares (group_id = p_group, grantee_id = p_user)
  -- or exists trip_shares s join trips t on t.id = s.trip_id
  --    where s.grantee_id = p_user and t.group_id = p_group        -- any trip owner
```
Execute: `shared_group_ids` (already granted) and `writable_group_ids` revoked from `public, anon`, granted to `authenticated`. `group_usable_by` and `group_reachable` revoked from `public, anon, authenticated` (only called inside definer functions and triggers, like `purpose_usable_by`).

### 2.3 Policies (owner policies and the existing grantee select policies stay)

| Table | New policy | Expression |
|---|---|---|
| `travel_groups` | write grantee update | using and with check `id = any ((select private.writable_group_ids()))` (grant stays `name, notes, trait_keys, description`) |
| `group_entries` | write grantee insert | with check `group_id = any ((select private.writable_group_ids()))` |
| `group_entries` | write grantee update | using and with check `group_id = any ((select private.writable_group_ids()))` |
| `group_entries` | write grantee delete | using `group_id = any ((select private.writable_group_ids()))` |

The select policies `travel_groups: grantee select` and `group_entries: grantee select` keep their text; they pick up the group-share branch through the redefined `shared_group_ids()`. No delete policy on `travel_groups` for grantees. `group_shares` gets the policies of 2.1.

### 2.4 Owner of entries written by a grantee **[G15]**

`private.inherit_group_owner()` (`security definer`, trigger-only, execute revoked from everyone): `new.owner_id := (select owner_id from public.travel_groups where id = new.group_id)`. Trigger `group_entries_00_inherit_owner` `before insert`. Same reasoning and failure modes as D9: a stranger's insert gets the real owner's id and fails the policy (42501); an unknown group leaves `owner_id` null.

### 2.5 Entry guard: `is_self` and links **[G2] [G16]**

`private.group_entries_guard()` (plpgsql, invoker, `set search_path = ''`, execute revoked from everyone), trigger `group_entries_01_guard` `before insert or update or delete` (fires after `_00_` on insert). Like `trips_owner_only` it acts only on user statements: `v_uid := auth.uid()`; when `v_uid is null or current_user <> 'authenticated'`, return unchanged (secret key, FK actions, definer functions such as `claim_group_entry`). Otherwise:

```text
INSERT: v_uid <> new.owner_id and new.is_self                                  → raise 'owner_only' (42501)
DELETE: v_uid <> old.owner_id and old.is_self                                  → 'owner_only' (42501)
        v_uid <> old.owner_id and old.linked_user_id is not null
          and old.linked_user_id <> v_uid                                      → 'linked_entry' (42501)
UPDATE: v_uid <> old.owner_id and new.is_self is distinct from old.is_self     → 'owner_only' (42501)
        old.linked_user_id is not null and (new.kind <> 'member' or new.is_self):
          v_uid in (old.owner_id, old.linked_user_id) → new.linked_user_id := null   (owner or linked user makes it ineligible)
          else                                        → 'linked_entry' (42501)
```
`replace_group_entries` runs as invoker, so the trigger guards it too: a write grantee's save that drops the `is_self` entry or someone else's linked entry fails as a whole (the server checks first and answers `forbidden`, 3.4). Label, notes and traits of the `is_self` entry stay editable for write grantees (G21). The owner's own edits never fail on a link: making a linked entry ineligible clears the link.

### 2.6 Links on `group_entries` **[G6] [G9]**

```sql
alter table public.group_entries
  add column if not exists linked_user_id uuid references auth.users (id) on delete set null;
alter table public.group_entries add constraint group_entries_link_shape
  check (linked_user_id is null or (kind = 'member' and not is_self));
alter table public.group_entries add constraint group_entries_link_not_owner
  check (linked_user_id is null or linked_user_id <> owner_id);
create unique index group_entries_one_link_idx on public.group_entries (group_id, linked_user_id)
  where linked_user_id is not null;
create index group_entries_linked_user_idx on public.group_entries (linked_user_id)
  where linked_user_id is not null;
```
Not in the insert or update grant of `group_entries`; `replace_group_entries` never writes it (its column lists stay explicit).

```sql
-- plpgsql, security definer, set search_path = ''. revoke all from public, anon; grant execute to authenticated.
-- Errors: raise exception '<code>' using errcode = 'P0001'; the server maps the message.
public.claim_group_entry(p_entry_id uuid) returns uuid          -- returns the group id
  -- 1. v_uid := auth.uid(); null or p_entry_id null           → 'forbidden'
  -- 2. select group_id, owner_id, kind, is_self, linked_user_id from group_entries where id = p_entry_id for update
  --    no row, or group_id <> all (private.shared_group_ids()) → 'not_found' (no hint that it exists)
  -- 3. owner_id = v_uid                                        → 'forbidden'   (the owner is is_self, never linked)
  -- 4. kind <> 'member' or is_self                             → 'not_eligible'
  -- 5. linked_user_id = v_uid                                  → return group_id (no-op)
  -- 6. linked_user_id is not null                              → 'already_linked'   (someone else)
  -- 7. exists (group_entries where group_id = g and linked_user_id = v_uid) → 'already_claimed' (undo first; no move)
  -- 8. update group_entries set linked_user_id = v_uid where id = p_entry_id
  --    (a parallel claim of another entry by the same user hits group_entries_one_link_idx: 23505 → 'already_claimed')
  -- 9. update trips set updated_at = now() where owner_id = v_uid and group_id = g   (their "about my age" may change)
public.unclaim_group_entry(p_entry_id uuid) returns table (group_id uuid, by_owner boolean)
  -- 1. v_uid null → 'forbidden'; select … for update; no row → 'not_found'
  -- 2. linked_user_id is null → return (group_id, owner_id = v_uid) (no-op)
  -- 3. linked_user_id = v_uid → allowed (undo, also while the owner is disabled)
  --    owner_id = v_uid       → allowed (owner removes)
  --    group_id = any (private.shared_group_ids()) → 'forbidden'; else 'not_found'
  -- 4. v_old := linked_user_id; update … set linked_user_id = null where id = p_entry_id
  -- 5. update trips set updated_at = now() where owner_id = v_old and group_id = g
```
The row lock of step 2 serializes two people claiming the same entry (the second gets `already_linked`). Neither function touches any other column; the entry's `updated_at` moves through the existing trigger, the group's does not (a link is not a group edit, so the owner's plans do not turn outdated, G22).

### 2.7 Group references on `trips` and `destination_searches` **[G12]**

- On both tables drop the composite FK `(group_id, owner_id) → travel_groups` (default names `trips_group_id_owner_id_fkey`, `destination_searches_group_id_owner_id_fkey`; backend-dev verifies with `\d` and uses `drop constraint if exists` for both the composite and a plain name, as migration 35 did for purposes) and add `foreign key (group_id) references public.travel_groups (id) on delete set null`.
- `private.check_group_ref()` (`security definer`, trigger-only), triggers `trips_check_group_ref` and `destination_searches_check_group_ref` `before insert or update of group_id`: null passes; an unchanged value on update passes (a reference to a group whose owner got disabled stays editable); otherwise `private.group_usable_by(new.group_id, new.owner_id)` or `raise 'group_not_usable' using errcode = '23503'` (both callers already map 23503 to `not_found`). On `trips` it fires after `trips_00_owner_only` (name order), so a grantee changing `group_id` on someone else's trip still gets 42501. Every existing row passes (same owner).
- `private.group_share_removed()` (`security definer`), trigger `group_shares_removed` `after delete on group_shares`:
  1. return early when the group no longer exists (cascade from a group delete: the FK already clears references).
  2. `update public.trips set group_id = null where owner_id = old.grantee_id and group_id = old.group_id` (fires `trips_group_changed`, 2.8, which prunes links of the people those trips were shared with)
  3. `update public.destination_searches set group_id = null where owner_id = old.grantee_id and group_id = old.group_id`
  4. `perform private.prune_group_links(old.group_id, old.grantee_id)` (2.8)
- `trips_group_exclusive` keeps working: the trigger only nulls `group_id`.

### 2.8 Clearing links when the last route ends **[G8]**

```sql
-- plpgsql security definer, execute revoked from everyone (called by triggers and definer functions only).
private.prune_group_links(p_group uuid, p_user uuid) returns void
  -- update public.group_entries e set linked_user_id = null
  --  where e.linked_user_id is not null
  --    and (p_group is null or e.group_id = p_group)
  --    and (p_user  is null or e.linked_user_id = p_user)
  --    and not private.group_reachable(e.group_id, e.linked_user_id)
```

| Event (a route ends) | Trigger | Call |
|---|---|---|
| group share revoked or left (also by cascade) | `group_shares_removed` (2.7) | `prune_group_links(old.group_id, old.grantee_id)` |
| trip share revoked or left, trip deleted (cascade), any trip owner | `trip_shares_prune_links` `after delete on trip_shares` | `prune_group_links(null, old.grantee_id)` |
| a trip's `group_id` changes or is cleared: by its owner, by `group_share_removed` (the trip owner lost the group share), or by the FK when the group is deleted | `trips_group_changed` `after update of group_id on trips` `when (old.group_id is not null and old.group_id is distinct from new.group_id)` | `prune_group_links(old.group_id, null)` |
| linked user's account deleted | FK `on delete set null` | – |
| group or trip owner disabled | none: hidden only (`shared_group_ids`, `shared_trip_ids`); links come back with the owner | – |

`group_reachable` counts every route (group share, or a share of any trip that uses the group) and ignores `is_active`, so a link survives as long as one route exists and is never removed because an owner is disabled. Chain example: B uses A's group on B's trip and shares it with D; D claims an entry. A revokes B's group share → `group_share_removed` clears `group_id` on B's trip → `trips_group_changed` prunes → D's link is cleared unless D still has a group share or another shared trip with the group. The trip-delete case works because the cascade deletes `trip_shares` after the trip row, so the trip no longer counts.

### 2.9 `share_resource`, `share_contacts`, admin stats (create or replace, same signatures)

- `public.share_resource`: `p_resource in ('trip','purpose','group')`. Step 3 for `'group'`: `perform 1 from public.travel_groups g where g.id = p_resource_id and g.owner_id = p_owner for no key update`. Steps 5 to 7 on `group_shares` (existing row → access change; `p_share_id` update-only; cap 10 under the lock; insert). Everything else unchanged (D24, D25).
- `public.share_contacts()`: add both directions of `group_shares` (grantees of my group shares always; owners of incoming group shares while active). Add one more branch: users linked to entries of my own groups (`group_entries.owner_id = auth.uid() and linked_user_id is not null`), returned with `display_name` and with `email` **only when they are also a share counterpart** (else empty string). A transitive claimer (1.3) may be someone the owner never shared with; the owner sees their display name on the entry (Alex: owner sees "{name} ✓"), never their email. Without a display name the UI falls back to "✓ Linked".
- `public.admin_share_stats(p_month_start)`: add `groupSharesRead`, `groupSharesWrite`, `groupsShared` (distinct groups), `entryLinks` (count of `group_entries` with `linked_user_id` not null); `recipients` and `grantsThisMonth` include `group_shares`. Counts only.

### 2.10 Optimistic check for group saves **[G17]**

`drop function public.replace_group_entries(uuid, jsonb, jsonb)` and create `public.replace_group_entries(p_group_id uuid, p_group jsonb, p_entries jsonb, p_expected_updated_at timestamptz default null)`, same body (still `security invoker`, grants unchanged), with one new first step: `select updated_at from public.travel_groups where id = p_group_id for no key update`; no row → `P0002` (a read grantee gets no row: `for no key update` needs the update policy); `p_expected_updated_at is not null and updated_at <> p_expected_updated_at` → `raise 'conflict' using errcode = '40001'`. Old callers with three named arguments resolve to the new function through the default.

---

## 3. Server (backend-dev)

### 3.1 Domain

`src/lib/domain/sharing.ts`:
```ts
export const SHARE_RESOURCES = ["trip", "purpose", "group"] as const;   // ShareInput etc. follow
export type IncomingShare = { /* as today */ group: TravelGroupSummary | null };
```
`src/lib/domain/group.ts`:
```ts
/** How the VIEWER sees an entry (1.5): their own, a named linked person (owner view), or someone linked. */
export type EntryLink = { kind: "me" } | { kind: "person"; name: string } | { kind: "account" };
export type StoredEntry = GroupEntry & {
  id: string; position: number; ageAsOf?: string;
  linkedUserId?: string;            // server use (age anchors); not secret, readable through RLS anyway
  link?: EntryLink;                 // display; the owner's is_self entry gets { kind: "me" } for the owner only
};
/** The group owner as recipients see them (decision A). birthdate only when the group has an is_self entry. */
export type GroupOwner = { id: string; name: string | null; birthdate: string | null; ageToday: number | null };
export type TravelGroup = {
  /* as today */ ownerId: string; access: Access; usable: boolean;
  owner: GroupOwner | null;         // null for the owner
  myEntryId: string | null;         // the viewer's own entry: is_self for the owner, the claimed entry for a recipient
};
export type TravelGroupSummary = { /* as today */ access: Access; sharedBy: Person | null; shareCount: number };
export const EntryLinkInput = z.object({ entryId: z.string().uuid() });
/** "That's me" is offered on an entry: viewer is not the owner, has no claim in this group, entry is a free named member. */
export function canClaim(group: TravelGroup, entry: StoredEntry): boolean;
```
`src/lib/domain/result.ts`: add `"already_linked"` (someone else is linked to this entry) and `"already_claimed"` (the viewer already claimed another entry of this group). `not_eligible` maps to `invalid`.

`src/lib/group.ts` (pure) **[G10] [G11]**:
```ts
/** Who `is_self` and `relativeToMe` refer to (spec group-sharing 1.4). Depends on the TRIP OWNER, never on the viewer. */
export type AgeRefs = {
  self: string | null;                                   // group owner's profile birthdate
  me: { birthdate: string | null } | { entryId: string; fallback: string | null };
  /** Whose age "about my age" is: wording only ("about my age" vs "about {name}'s age"). */
  meIs: "tripOwner" | "groupOwner";
  /** Entry that stands for the trip owner (plan label "self"): the is_self id when T = G, the linked entry when T ≠ G. */
  tripOwnerEntryId: string | null;
};
export function ageRefs(a: {
  tripOwnerId: string; tripOwnerBirthdate: string | null;
  groupOwnerId: string | null;                           // null: own group or the trip's one-off group (T = G)
  groupOwnerBirthdate: string | null;
  entries: { id?: string; isSelf?: boolean; linkedUserId?: string | null }[];
}): AgeRefs;
// resolveAge / resolveGroupAges / resolveGroup / resolveTravellerAge accept `AgeRefs | string | null` (a string keeps
// today's meaning: one birthdate for both). The linked entry's "me" age: birthdate → ageOn; exact|approx → stated age
// advanced from ageAsOf; else fallback → ageOn; else unknown ("aboutMyAge" status for relativeToMe).
// ResolvedEntry gains `isTripOwner: boolean` and `birthdate?: string` (display only; groupInput never copies it).
```
`src/lib/plan/input.ts` `groupInput`: the `"self"` label goes to `row.isTripOwner` instead of `row.isSelf` (identical for every `T = G` trip, so hashes do not change). `BuildPlanInputArgs.profileBirthdate` becomes `ageRefs: AgeRefs`; same in `src/lib/discover/input.ts`.

Display labels ("You", owner name, "{name} ✓", "✓ Linked") are computed from `myEntryId` and `link` (viewer), ages from `AgeRefs` (trip owner). Components never derive "You" from `isSelf` alone (today `AgePreview` and `SharedContext` do; both change, 4.2 and 4.4).

### 3.2 Actions

`src/lib/server/sharing.ts`: table maps gain `group: "group_shares"`, `travel_groups`, `group_id`. `shareWith`, `setShareAccess`, `unshare`, `leaveShare`, `listGrants` work unchanged for `"group"`. `listSharedWithMe` adds a third parallel query `group_shares … travel_groups(id, name, notes, description, updated_at, group_entries(count))`. Events unchanged with `resource: "group"`.

New `src/lib/server/group-links.ts` ("use server"):

| Action | Steps |
|---|---|
| `claimGroupEntry({ entryId })` | session (401) → Zod → `rpc("claim_group_entry")` with the **user session** → map `not_found`, `forbidden`, `not_eligible → invalid`, `already_linked`, `already_claimed` (also 23505) → event `sharing.entry_linked { groupId }` |
| `unclaimGroupEntry({ entryId })` | session → Zod → `rpc("unclaim_group_entry")` → map errors → event `sharing.entry_unlinked { groupId, by: "self" \| "owner" }` |

No secret key: the functions take `auth.uid()` and check everything themselves. Demo needs no extra check (it can never see a shared group).

### 3.3 Owner context for groups **[G10]**

- `src/lib/server/owner-context.ts`: new `loadGroupOwnerBirthdate(groupOwnerId): Promise<{ birthdate: string | null; displayName: string | null } | null>`, secret key, explicit columns `birthdate, display_name`, called only after the group row was read through RLS (so never for a disabled owner). Null → callers fail closed.
- `plan-pipeline.ts` `loadPlanContext`: after the group read, `G = group.ownerId`. `G = T` → `groupOwnerBirthdate` = the owner-context birthdate already loaded. `G ≠ T` → `loadGroupOwnerBirthdate(G)`; null → `failed`. Builds `ctx.ageRefs = ageRefs({ tripOwnerId: T, tripOwnerBirthdate: ctx.birthdate, groupOwnerId: G, groupOwnerBirthdate, entries })`. `GroupContext` gains `ownerId?` and entries carry `linkedUserId`.
- `discover/pipeline.ts`: the group loads through RLS **and** must be `usable` (a group seen only through a shared trip → `not_found`, the trigger's answer); anchors as above with `T` = the searcher.

### 3.4 Changes to existing server code **[G18]**

| File | Change |
|---|---|
| `groups.ts` `GROUP_COLUMNS` / `ENTRY_COLUMNS` | add `owner_id`, `linked_user_id`; `group_shares(grantee_id, access)` embedded for the access mapping |
| `groups.ts` `listGroups` | keeps `.eq("owner_id", userId)`; adds `group_shares(count)` for `shareCount`; shared groups come from `listSharedWithMe` |
| `groups.ts` `getGroup` | `access`, `usable`, `myEntryId`, `link` per entry for the viewer (`share_contacts` names for the owner's view), `owner: GroupOwner` for non-owners: `birthdate` only when an `is_self` entry exists, else `ageToday` only |
| `groups.ts` `updateGroup` | `access === "read"` → `forbidden`. Non-owner pre-checks (clear error before the RPC; the trigger enforces anyway): the `is_self` entry is kept with the same id and `isSelf`, no new `isSelf`, entries linked to someone else are kept and stay eligible → else `forbidden`. New argument `expectedUpdatedAt` → `p_expected_updated_at`; 40001 → `conflict`; 42501 → `forbidden` |
| `groups.ts` `loadGroupParsed` | `ensureGroupParse(session, { table: "travel_groups", id, ownerId: group.ownerId }, …)`: the parse is stored on the owner's row; the AI call stays charged to the actor (Alex) |
| `groups.ts` `deleteGroup` | unchanged (RLS owner only; a grantee gets `not_found`) |
| `groups.ts` `reorderGroupEntries` | `access === "read"` → `forbidden`; otherwise unchanged (update policy) |
| `group-mapping.ts` | `GroupEntryRow.linked_user_id`; `rowToEntry` maps it; `entryToRow` never writes it |
| `trips.ts` | 23503 comment: group not usable; trip form options add usable shared groups |
| `sharing.ts` `getTripOwnerContext` | returns `ownerBirthdate` (decision A) instead of `ownerAge`; same RLS-first rule. When the trip's group belongs to someone else, also the group owner's name and birthdate (`loadGroupOwnerBirthdate`, only with an `is_self` entry) |
| `discover/store.ts`, `discover/prefill.ts` | `buildTripDraft` drops `groupId` when the group is no longer usable (as for purposes) |
| `admin/stats.ts` | reads the new counts |
| `plan-document.ts` | unchanged (reads `kind, count` through RLS; a shared group is readable) |

### 3.5 Two editors at once
Group form: optimistic `updated_at` check (2.10), same UI as trips and purposes (`sharing.conflictForm`, "Load latest" / "Save anyway"; "Save anyway" sends no `expectedUpdatedAt`). A "That's me" never conflicts with a form save (different column, and the form never writes it).

### 3.6 Account deletion, disable
- Owner deleted: their groups cascade with shares; recipients' trips and searches lose `group_id` (FK), which prunes links of people those trips were shared with. Linked user deleted: link set null. Grantee deleted: share rows cascade, triggers clear their trips and links.
- Disabled group owner: hidden on every recipient path (`shared_group_ids`, `group_usable_by`, `share_contacts`). A recipient's own trip that references the group keeps `group_id`, and the plan context treats the unreadable group like a missing one (same as purposes).
- Delete-account dialog text names groups too (4.6).

---

## 4. UI (frontend-dev)

### 4.1 Group page, owner
- People block (`src/components/sharing/people-share.tsx`, `resource="group"`) on `/app/groups/[id]`, notice `sharing.groupShareNotice` always visible above the button.
- The owner's `is_self` entry: "You" as today. Linked entries: "{name} ✓" (`sharing.link.linkedTo`) and a "Remove link" button (`ConfirmDialog`, `sharing.link.confirmRemove`). No name known → `sharing.link.linked`.

### 4.2 Group page, recipient
- Header: `SharedHeader resource="group"` with badge and "Leave" (`sharing.confirmLeaveGroup`). Shown for group shares; a group seen only through a trip opens from the trip's group block in read-only mode without "Leave".
- Read: read-only view of all entries (names, birthdates, ages), no edit controls.
- Write: `GroupEditor` with: no "this is me" toggle (`groups.editor.ownerOnlySelf`); the `is_self` row shows the owner's name and birthdate, its label, notes and traits stay editable; delete hidden on the `is_self` row and on entries linked to someone else (hint `groups.editor.linkedLocked`).
- Labels per viewer (1.5): the owner's `is_self` row = `sharing.groupBlock.groupOwner` with name and birthdate; the viewer's claimed entry = "You" (`sharing.link.you`) with "That's not me" (`sharing.link.notMe`); other linked entries = `sharing.link.linked`.
- "That's me" (`sharing.link.thatsMe`, hint `sharing.link.hint`) on eligible entries only while `myEntryId` is null (`canClaim`). Once the viewer has claimed an entry, no other entry offers it; switching means "That's not me" first. A server `already_claimed` / `already_linked` shows its error and reloads the group.
- Age preview: `AgePreview` takes `AgeRefs` (3.1) built on the server as if the viewer were the trip owner (G24): self = owner's birthdate (only with an `is_self` entry), me = the viewer's claimed entry (fallback the viewer's own profile birthdate) or the owner (`birthdateForAge(owner.ageToday, date)` stand-in when no birthdate was sent). `meIs: "groupOwner"` shows `groups.preview.aboutOwner`. The preview's "me" label (`groups.preview.me`) goes to `myEntryId`, not to `isSelf`.

### 4.3 Lists and pickers
- `/app` groups column and `/app/groups`: own groups as today with "Shared · {n}"; a "Shared with me" section with badge "{name} · {level}".
- Trip form and "Find destinations" form: group select lists own groups, then an optgroup `sharing.sharedOptgroup` with `sharing.optionShared` (usable shared groups only).

### 4.4 Trip pages (closes #129)
- `SharedContext` group block on a shared trip: every member with a birthdate shows "born {date}" (`sharing.groupBlock.born`, date formatted in the UI) next to the age; the `is_self` row shows the owner's name, birthdate and age. `birthdateForAge` is no longer used here (`getTripOwnerContext` returns the birthdate).
- Labels per viewer as in 1.5: the viewer's own entry (`is_self` for the group owner, the claimed entry for a recipient) is "You"; the group owner's `is_self` entry is `sharing.groupBlock.self` ("{name} (trip owner)") when the group owner owns the trip, else `sharing.groupBlock.groupOwner`. Ages follow the trip owner's `AgeRefs`.
- On a recipient's own trip using a shared group, the group block (pills, party size) uses the anchors of 1.4.
- On every trip whose group the viewer can see (also transitive), eligible entries offer "That's me" for read and write recipients, under the same one-claim rule (4.2).
- Share notice on trips: `sharing.groupNotice` (new text, 4.6).

### 4.5 Mobile
360 px: link buttons full width under the entry name, `min-h-11`, badge text always present (not colour only), no horizontal scroll.

### 4.6 i18n (de + en, same keys) **[G19]**

| Key | en | de |
|---|---|---|
| `sharing.groupNotice` (changed) | They will see the whole trip, including the travel group with names and birthdates (yours too, if you are in it). | Die Person sieht die ganze Reise, auch die Reisegruppe mit Namen und Geburtsdaten (auch deins, wenn du dabei bist). |
| `sharing.groupShareNotice` | They will see every entry with names and birthdates, yours too if you are in the group. They can use the group for their own trips and mark an entry as themselves. People they share those trips with can see it there. | Die Person sieht alle Einträge mit Namen und Geburtsdaten, auch deins, wenn du in der Gruppe bist. Sie kann die Gruppe für eigene Reisen nutzen und einen Eintrag als sich selbst markieren. Wer diese Reisen von ihr geteilt bekommt, sieht die Gruppe dort. |
| `sharing.confirmLeaveGroup` | You lose access. Your own trips and searches that use this group lose it. {name} keeps the group. | Du verlierst den Zugriff. Deine eigenen Reisen und Suchen mit dieser Gruppe verlieren sie. {name} behält die Gruppe. |
| `sharing.groupBlock.groupOwner` | {name} (group owner) | {name} (Besitzer der Gruppe) |
| `sharing.groupBlock.born` | born {date} | geb. {date} |
| `sharing.link.thatsMe` | That's me | Das bin ich |
| `sharing.link.notMe` | That's not me | Das bin nicht ich |
| `sharing.link.you` | You | Du |
| `sharing.link.linkedTo` | {name} ✓ | {name} ✓ |
| `sharing.link.linked` | ✓ Linked | ✓ Verknüpft |
| `sharing.link.hint` | Mark the entry that is you. Nothing else changes; the owner sees it. You can mark only one entry. | Markiere den Eintrag, der du bist. Sonst ändert sich nichts; der Besitzer sieht es. Du kannst nur einen Eintrag markieren. |
| `sharing.link.remove` | Remove link | Verknüpfung entfernen |
| `sharing.link.confirmRemove` | {name} is no longer marked as this entry. The entry stays. | {name} ist nicht mehr als dieser Eintrag markiert. Der Eintrag bleibt. |
| `sharing.errors.already_linked` | Someone else already said this is them. | Jemand anderes hat diesen Eintrag schon als sich markiert. |
| `sharing.errors.already_claimed` | You already marked another entry in this group. Undo that first. | Du hast in dieser Gruppe schon einen anderen Eintrag markiert. Nimm das zuerst zurück. |
| `groups.preview.aboutOwner` | about {name}'s age | etwa im Alter von {name} |
| `groups.editor.ownerOnlySelf` | Only {name} can change who "me" is. | Nur {name} kann ändern, wer „ich“ ist. |
| `groups.editor.linkedLocked` | Linked to someone: only they or the owner can delete it. | Mit jemandem verknüpft: nur diese Person oder der Besitzer kann den Eintrag löschen. |
| `settings.deleteAccount.sharedNote` (changed) | Trips, purposes and groups you shared are deleted too; people you shared them with lose access. Shares others gave you simply end. | Reisen, Reisezwecke und Gruppen, die du geteilt hast, werden mitgelöscht; die Personen verlieren den Zugriff. Freigaben, die andere dir gegeben haben, enden einfach. |
| `admin.usage.groupShares`, `admin.usage.entryLinks` | Group shares (read / edit), Linked entries | Gruppen-Freigaben (lesen / bearbeiten), Verknüpfte Einträge |

---

## 5. Tests

pgTAP `supabase/tests/group-sharing.test.sql` (actors as sharing.md 5: A owner, B write grantee, C read grantee, D stranger, E demo, F owner who gets disabled, plus T a trip-only recipient of A's trip that uses A's group, and R a recipient of B's own trip that uses A's group; grants created with `share_resource` as `service_role`):
- No group shares yet: B, C, D see exactly what they saw before (widened policies add nothing); `claim_group_entry` by D → `not_found`.
- Write path: no insert or update privilege on `group_shares` for `authenticated`; `share_resource('group', …)`: A's group ok; another owner's group → `not_found`; E/F as owner → `forbidden`; self → `self_share`; E/F/unknown grantee → `no_account`; repeat changes access; 11th grantee → `limit_reached`, level change at 10 works; stale `p_share_id` → `not_found`.
- Visibility: B, C see group and entries; D none; own lists (`owner_id = auth.uid()`) exclude it; after unshare nothing; R sees A's group read-only through B's trip (transitive) and cannot write it.
- Writes: B updates name/notes/description/trait_keys, inserts an entry (`owner_id = A`), updates and deletes a plain entry, edits label/notes/traits of A's `is_self` entry, runs `replace_group_entries` and `reorder_group_entries`; C gets 42501 / 0 rows for each; B cannot delete the group, cannot write `parsed_*` or `linked_user_id` (column privilege), cannot insert an `is_self` entry, flip `is_self`, delete the `is_self` entry, or delete / change kind of an entry linked to C (42501); B can delete an entry linked to B; A can do all of it, and making a linked entry ineligible clears the link.
- Claims: C (read) claims an eligible entry; claiming an `is_self`, composition or someone else's linked entry → `not_eligible` / `already_linked`; C claiming a second entry in the same group → `already_claimed` and the first link stays; after C's undo C can claim the other entry; B cannot unclaim C's link (`forbidden`), C can, A can; A cannot claim (`forbidden`); T (trip-only, A's trip) can claim; R (trip-only, B's trip) can claim; claim bumps `updated_at` of the claimer's trips using the group, not A's group `updated_at` and not A's trips.
- Pruning (every route counted): C leaves the group share → C's link cleared; T's trip share revoked → T's link cleared; A moves the trip to another group → T's link cleared; T with both a group share and a trip share keeps the link after one of them ends; A deletes the trip → T's link cleared; A revokes B's group share → B's trip loses `group_id` and R's link is cleared; R keeps the link in the same scenario when R also has a group share; B moves B's trip to another group → R's link cleared; deleting C's account nulls the link; disabling A (or B) keeps links and hides everything, re-enabling restores.
- Own use: B and C attach A's group to their own trip and search; D cannot (23503); a group seen only through a shared trip cannot be attached (23503); after unshare B's trip and search have `group_id` null and B's trip has a new `updated_at`; A deleting the group clears them; F's group (disabled) cannot be attached; an unchanged `group_id` on B's trip stays editable while F is disabled.
- `replace_group_entries` with a stale `p_expected_updated_at` → 40001; with null → ok; three named arguments still resolve.
- `share_contacts`: includes group counterparts; for A includes R (transitive claimer) with display name and empty email; for R does not include anyone new.
- `admin_share_stats` has the new keys and no ids.
- Trigger order: `group_entries_00_inherit_owner` before `group_entries_01_guard`; `trips_00_owner_only` before `trips_check_group_ref`.

Concurrency (`supabase/tests/sharing-concurrency.sh`): the 10-cap case for `'group'`; two sessions claim the same entry → second `already_linked`; one user claims two entries in two sessions → second `already_claimed`, exactly one link.

Unit (Vitest):
- `group.test.ts`: `ageRefs` for the three cases of 1.4; linked entry with birthdate, stated age, `relativeToMe`, nothing (fallback), no fallback (`aboutMyAge`); `T = G` result equals today's single-birthdate result for a fixture group; `isTripOwner` placement.
- Example of 1.5 as a table test (`domain/group.test.ts` or `group.test.ts`): for viewers A, B, C the group view yields the labels of 1.5; for `T = A` and `T = B` the plan `"self"` label and the `relativeToMe` age land on the right entry; the viewer does not change ages or the hash.
- `plan/input.test.ts`: `"self"` label on the linked entry for `T ≠ G`, none on the `is_self` row; unchanged hash for the existing fixtures.
- `plan-pipeline.test.ts`: `G ≠ T` reads `G`'s birthdate with the secret key after RLS; null → `failed`; a write grantee of `T`'s trip gets the same hash as `T`.
- `server/groups.test.ts`: read → `forbidden`; non-owner pre-checks; `expectedUpdatedAt` → `conflict`; parse saved with the group owner's id and logged with the actor's id; `owner.birthdate` only with an `is_self` entry; `link` and `myEntryId` per viewer.
- `domain/group.test.ts`: `canClaim` false for the owner, after an own claim, on `is_self`, compositions and linked entries.
- `server/group-links.test.ts`: error mapping (incl. 23505 → `already_claimed`), events without names.
- `server/sharing.test.ts`: `"group"` resource paths, `listSharedWithMe` with groups, `getTripOwnerContext` returns the birthdate.
- `discover/pipeline.test.ts`, `discover/prefill.test.ts`: usable gate and dropped `groupId`.
- `domain/sharing.test.ts`: `SHARE_RESOURCES` includes `group`; cap constant unchanged.
- UI: `sharing-ui.test.tsx` labels per viewer, no "That's me" after a claim, owner-only controls; `helpers.test.ts` keeps `birthdateForAge` for the preview.

E2E (Playwright, mobile and desktop):
1. A shares a group with B (write); B edits an entry name and the group text; A sees the change.
2. The 1.5 example: A's group has A (`is_self`) and "B"; B says "That's me"; A sees "B ✓" and "You" on A's entry; B sees "You" on "B" and A's name on A's entry; no other entry offers "That's me" to B; B undoes and the buttons return.
3. B picks A's group for B's own trip; the `is_self` row shows A's name and birthdate; "about my age" shows A's age before the claim and B's entry's age after it; the plan is outdated after the claim.
4. B shares that trip with R; R claims an entry; A revokes B's group share; B's trip shows no group and R's link is gone.
5. A shared trip shows birthdates for all members, including A's (#129).
6. 360 px screenshots of the group page with link buttons and the share box.

---

## 6. Delivery split **[G20]**

| PR | Owner | Content | Depends on |
|---|---|---|---|
| 1 | backend-dev | migration 37 (section 2), `group-sharing.test.sql`, concurrency cases; CLAUDE.md ground rule 6 amendment (section 7) | – |
| 2 | backend-dev | domain, `group.ts` anchors, `plan/input.ts`, `discover/input.ts`, `group-links.ts`, all of 3.2 to 3.6, unit tests | PR 1 deployed |
| 3 | frontend-dev | section 4, i18n, E2E; removes `birthdateForAge` from the trip page | PR 2 |

**Why PR 1 is safe alone:** every new policy depends on a `group_shares` row; none can exist (no client privilege; the current `ShareInput` Zod enum rejects `"group"`, so the deployed server never passes it to `share_resource`). The redefined `shared_group_ids` adds an empty branch, and its new `is_active(group owner)` check equals the old trip-owner check because today group owner = trip owner. The FK swap accepts every row. The guard trigger only restricts non-owners, who cannot write groups yet; owner edits that make a linked entry ineligible clear a link nobody can set through the UI. `replace_group_entries` keeps working with three arguments. `claim_group_entry` is callable by today's trip recipients through the Data API before the UI exists; the result is a label the deployed code never reads (not selected), so it changes nothing until PR 2.
**PR 2 order:** the owner-id fix in `loadGroupParsed`, the access checks in `updateGroup` / `reorderGroupEntries` and the usable gate in discover ship in the same deploy as `"group"` in `SHARE_RESOURCES`. Nobody creates group shares by hand before PR 2 is live.

---

## 7. CLAUDE.md ground rule 6 (approved by Alex, 2026-11-07; applied in the first implementation PR)

> 6. **Users see only their own data.** Every user-owned resource table has `owner_id` with an RLS policy `owner_id = auth.uid()`; the share tables `trip_shares`, `purpose_shares` and `group_shares` use owner-or-grantee policies instead. Exception: a trip, trip purpose or travel group the owner shared with a named user is also visible to that user, read-only or read/write, through `private.*` helper functions; a shared trip shows its group and purpose read-only (`docs/specs/sharing.md`, `docs/specs/group-sharing.md`). Public share links are read through a server route by token only. Secrets stay server-side (never `NEXT_PUBLIC_`).

Ground rule 4 is unaffected: `linked_user_id` stores no age; the owner's birthdate is read from the profile, ages stay computed.

---

## 8. Files

| Area | Files |
|---|---|
| DB | `supabase/migrations/20261112120037_group_sharing.sql`, `supabase/tests/group-sharing.test.sql`, `supabase/tests/sharing-concurrency.sh` |
| Domain | `src/lib/domain/{sharing,group,result}.ts` |
| Pure | `src/lib/group.ts`, `src/lib/group-text.ts`, `src/lib/plan/input.ts`, `src/lib/discover/{input,prefill}.ts` |
| Server | `src/lib/server/group-links.ts` (new), `groups.ts`, `group-mapping.ts`, `group-text.ts` (comment only), `owner-context.ts`, `sharing.ts`, `plan-pipeline.ts`, `trips.ts`, `discover/{pipeline,store}.ts`, `admin/stats.ts` |
| UI | `src/components/groups/{group-editor,entry-editor,age-preview}.tsx`, `src/components/groups/group-view.tsx` and `src/components/sharing/entry-link.tsx` (new), `src/components/sharing/{people-share,shared-context,shared-header,share-badge,helpers}.tsx/ts`, `src/app/[locale]/app/groups/[id]/page.tsx`, groups list, `/app` groups column, trip form, discover form, trip page, settings delete dialog, admin usage |
| i18n | `messages/de.json`, `messages/en.json` |
| Docs / rules | `CLAUDE.md` ground rule 6 (PR 1), `docs/architecture.md` isolation line, `docs/specs/find-destinations.md` section 8 pointer |

---

## 9. Risks
1. Privacy: recipients now see the owner's profile birthdate on the `is_self` entry (decision A), also on shared trips and transitively through a recipient's trip (Alex, accepted). Both share notices say so before the button.
2. Write grantees can edit and delete entries describing other people; the guard keeps `is_self` and other people's linked entries out of their reach, nothing else.
3. A link is self-declared: anyone with access, also through someone else's trip, can claim a free entry. The owner sees it at once (display name, never the email of a stranger) and can remove it; nothing but "about my age" and the plan's `"self"` label on the claimer's own trips depends on it.
4. The redefined `shared_group_ids()` widens two tables again; a missed owner filter shows a shared group in "my groups". `listGroups` already filters; review greps unfiltered `from("travel_groups")`.
5. `G ≠ T` adds one secret-key profile read per plan run; it happens only after RLS showed the group and selects two columns.
6. Pruning runs in triggers on `trip_shares`, `group_shares` and `trips`, partly chained (a group share removal clears a trip's group, which prunes its recipients' links); the cascade paths (group delete, account delete, trip delete) and the chain are covered by pgTAP because trigger order inside cascades is easy to get wrong.
7. A link tug-of-war (owner removes, recipient re-claims) is possible; accepted by Alex.
8. Changing `replace_group_entries`' signature needs PostgREST's schema reload (automatic on Supabase DDL).
9. Plans of a recipient's trips change when the owner edits the group (same as purposes) or when the recipient links an entry; both show as outdated, regeneration costs the actor.
10. `linked_user_id` uuids are readable by every viewer of the group through the Data API. They reveal no name or email; `is_active` probing needs a known id.

---

## 10. Relation to sharing.md
- D4 is reversed for shared trips and shared groups (decision A). sharing.md 1.1, 4.3, D4 and section 10 point here.
- sharing.md 2.5 "`group_id` keeps its composite FK" is superseded by 2.7 here.
- sharing.md 1.2 (owner context) is extended by 1.4 here for `T ≠ G`; for `T = G` nothing changes.

---

## 11. Decisions
- **[G1] (Alex)** Groups are shareable read-only or read/write, live, like trips and purposes. Write: name, notes, entries, group text, trait keys. Owner only: delete, share, unshare, change access. Recipient can leave. Listed under "Shared with me". No notification email. AI costs of the group-text parse go to the acting user; the parse is stored on the owner's row.
- **[G2] (Alex)** Write grantees cannot touch `is_self` (set, move, add, delete) and cannot delete or make ineligible an entry linked to another user: only the owner and the linked user may delete a linked entry.
- **[G3]** A group reached only through a shared trip has access `read`, `usable: false`, like purposes (D5).
- **[G4] (Alex)** Recipients see all entries with names and birthdates; the owner's `is_self` entry shows the owner's display name and profile birthdate (decision A), for shared groups and shared trips. Reverses D4. Shared trips show all birthdates (#129). The owner's birthdate leaves the server only when the group has an `is_self` entry.
- **[G5] (Alex)** Link display: the owner sees the linked person's display name ("{name} ✓"), the linked user sees "You", everyone else sees "✓ Linked" without a name. A transitive claimer's email is never shown to the owner.
- **[G6] (Alex)** "That's me": any recipient (read or write) who can see the group links a free named member entry to their account, immediately, without confirmation. One link per entry. Undo by the user, removal by the owner. Only through `claim_group_entry` / `unclaim_group_entry`; no column grant.
- **[G7] (Alex)** "That's me" works through a group share and through every shared trip that uses the group, whoever owns the trip (also another recipient's trip).
- **[G8] (Alex)** A link is cleared when its user has no route left to the group (group share, or a share of any trip using the group; account deleted). Disabled owner: hidden only. Implemented by `prune_group_links` triggers with `group_reachable`, which counts every route and ignores `is_active`.
- **[G9] (Alex)** One claimed entry per user per group. While a user has a link, "That's me" is not offered on other entries; the server refuses a second claim (`already_claimed`), no move. After an owner removes a link, the user can claim again right away.
- **[G10] (Alex, decisions B and D)** A link is a label: the profile birthdate never replaces typed data; the linked user edits typed data like any field (with write access). "About my age" on a recipient's own trip refers to the group owner until the trip owner linked an entry, then to the linked entry's typed age, falling back to the trip owner's profile birthdate. `is_self` always refers to the group owner. The actor never matters, so hashes do not depend on who presses the button.
- **[G11] (Alex)** The plan's `"self"` label goes to the entry that stands for the trip owner (the linked entry on a recipient's own trip, when it has no label of its own); the owner's `is_self` entry is an ordinary traveller there. Unchanged for every existing trip.
- **[G12] (Alex)** A recipient can use a shared group for own trips and destination searches. Plain FK plus `check_group_ref` trigger on `trips` and `destination_searches`; unshare or leave clears the reference and outdates the plans.
- **[G13] (Alex)** Transitive visibility through a recipient's trip, read-only, as for purposes.
- **[G14]** A third access table `group_shares`, same shape and rules as the other two (D7, D24, D25).
- **[G15]** Entries written by a grantee take the group owner's `owner_id` in a `before insert` trigger (D9 pattern).
- **[G16]** Owner-only rules on entries are a trigger, not grants (D10 pattern).
- **[G17]** Group saves get the optimistic `updated_at` check (D17 pattern) through a defaulted fourth argument of `replace_group_entries`.
- **[G18]** Server reads that mean "mine" filter by owner; the parse cache uses the row owner's id (D16).
- **[G19]** i18n under `sharing.link.*` plus a few `sharing.*` and `groups.*` keys.
- **[G20]** Delivery as three stacked PRs; the migration ships first and alone. The CLAUDE.md rule 6 amendment (Alex, approved) lands in PR 1.
- **[G21] (Alex)** Write grantees may edit label, notes and traits of the owner's `is_self` entry.
- **[G22] (Alex)** Linking or unlinking outdates only the linked user's own trips that use the group, never the owner's.
- **[G23] (Alex)** Labels are per viewer: "me"/"You" is the viewer's own entry (the `is_self` entry for the owner, the claimed entry for a recipient); the owner's entry shows the owner's display name to everyone else. Ages and the plan's `"self"` label follow the trip owner. Example in 1.5.
- **[G24] (Alex)** The group page preview for a recipient uses the "about my age" rule of the recipient's own trips.

---

## 12. Implementation notes (PR 1, migration 37)
- `claim_group_entry` checks the owner (`forbidden`) before visibility (`not_found`). The order in 2.6 would make `forbidden` unreachable: an owner's own group is not in `shared_group_ids()`, so the owner would always get `not_found`.
- `unclaim_group_entry` returns the harmless no-op for an unlinked entry only to callers who can see the group (or the owner); everyone else gets `not_found`, so the function cannot be used to probe whether an entry id exists.
- `claim_group_entry` catches the unique violation of `group_entries_one_link_idx` itself and raises `already_claimed` (P0001), so the server needs no extra 23505 mapping (it may keep one).
- The DO block of 2.7 drops every two-column foreign key from `trips` and `destination_searches` to `travel_groups`, whatever its name, instead of guessing the default name; `destination_searches_group_idx` is added for the new plain FK (the composite FK had no index on `group_id`).
- Existing tests changed because the behaviour they pinned is superseded: `sharing.test.sql` (composite group FK gone, `'group'` is now a valid resource so the "unknown kind" case uses `'plan'`, thirteen admin counters), `rls.test.sql` (an entry inserted into someone else's group now fails the owner policy with 42501 after the inherit-owner trigger instead of the composite FK with 23503; the privilege check names the four-argument `replace_group_entries`).
- Claim vs. revoke race (QA review): `claim_group_entry` share-locks its route rows (the caller's `group_shares` row and the `trip_shares` and `trips` rows of trips using the group) before it locks the entry, and raises `not_found` when no route row is left. A revoke deletes or changes those rows, so it waits for the claim to commit and its prune trigger then sees the link; the lock order (route, then entry) matches the revoke path, so there is no deadlock. Covered by case 5 of `sharing-concurrency.sh`. The spec's steps 2 to 9 are otherwise unchanged.

## 13. Implementation notes (PR 2, server)
- `AgeRefs` has no extra field; "this entry stands for the trip owner" (`ResolvedEntry.isTripOwner`) is derived: `me` is a birthdate and `meIs = "tripOwner"` means T = G (the `is_self` row), `me` is an entry means T != G (that entry). Added helpers next to `ageRefs()`: `ownAgeRefs(birthdate)` (T = G with one birthdate, what a plain string always meant), `toAgeRefs()` (string or null to `AgeRefs`) and `meAge()` (the age "about my age" refers to). `resolveAge` takes the entries as an optional fourth argument for the linked-entry case. `resolveTravellerAge` (parsed travellers) has no entries, so a linked entry gives its fallback birthdate there; this cannot occur because `ageRefs()` only links when the group has entries and parsed travellers are used only without entries.
- `getTripOwnerContext` returns `{ owner, ownerBirthdate, ownerAge, groupOwner }`. `ownerAge` is kept next to the new `ownerBirthdate` (3.4 said "instead of"): `ownerBirthdate` is set only when the trip's own group (group owner = trip owner) has an `is_self` entry, so a trip without one still needs the age for the "about my age" stand-in (1.2: "at most the owner's age"). `groupOwner` is `TravelGroup.owner` of the trip's group when it belongs to someone else (same birthdate rule), null otherwise; it comes from `getGroup`, which reads the profile through `loadGroupOwnerBirthdate`.
- `getGroup` does not fail when the group owner's profile cannot be read; the `owner` block degrades to name null and birthdate null (display only, nothing leaks). The plan pipeline and destination searches fail closed (`failed`), as specified.
- The shared contact lookup (`loadContacts`, `personOf`) moved from `sharing.ts` to `share-contacts.ts`: `groups.ts` needs it for the owner's "{name} ✓" and `sharing.ts` now imports `getGroup`, which would have been an import cycle.
- `claimGroupEntry` / `unclaimGroupEntry` return `{ groupId }` on success. `unclaim_group_entry` is read as a table (`data[0]`). The server keeps a 23505 to `already_claimed` mapping although the function maps it itself (12, PR 1).
- `IncomingShare` gets `group: TravelGroupSummary | null`; `TravelGroupSummary` gains `access`, `sharedBy`, `shareCount`. A group share is always usable, so the summary has no `usable` flag.
- Errors `already_linked` and `already_claimed` are `ActionError` values with HTTP 409 in `respond.ts`. The message keys (`sharing.errors.already_*`) and `shareErrorKey()` in `helpers.ts` are PR 3, so these two fall back to the generic text until then.
- `TravelGroup` is viewer-specific (`access`, `usable`, `owner`, `myEntryId`, `link` per entry). `getGroup` calls `share_contacts` only for an owner whose group has linked entries.
- Minimal non-server edits to keep the app consistent: the trip page uses the real `ownerBirthdate` when the context has one (the `birthdateForAge` stand-in stays for the other case until PR 3), `trips/new` passes `usableGroupIds` to `buildTripDraft`, `sharedGroupOptions()` joins `sharedPurposeOptions()` in `helpers.ts`. The trip page does not yet build `AgeRefs` for a recipient's own trip with someone else's group (PR 3); the plan pipeline and destination search do.
