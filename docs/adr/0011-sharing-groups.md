# ADR 0011: Sharing travel groups and linking entries to accounts

Status: proposed (draft, awaiting Alex's review) · Date: 2026-11-07 · Spec: `docs/specs/group-sharing.md` (decisions G1 to G20, open questions Q1 to Q12) · Issue #129, follow-up of #82 · Amends ADR 0010 (owner birthdate on shared trips; group references)

## Context
ADR 0010 made trips and purposes shareable and left groups out, because a hand-entered member ("Ben", typed birthdate) cannot be matched to Ben's account by name (sharing.md section 10). It also kept the owner's profile birthdate away from recipients (D4), while the trip share notice promised "names and birthdates" and the shipped group block shows ages only (#129). Alex has now decided: groups are shareable at two levels like trips and purposes; recipients see all details including every birthdate and the owner's own profile birthdate on the `is_self` entry; any recipient can mark an entry as themselves ("That's me") without owner confirmation, as a label only; a recipient can use a shared group for their own trips; "about my age" on such a trip refers to the group owner until the recipient has linked an entry. Groups use composite same-owner FKs from `trips` and `destination_searches`, a security-invoker `replace_group_entries`, and one profile birthdate for both `is_self` and `relativeToMe`.

## Decision
1. **A third access table `group_shares`**, identical in shape and rules to `trip_shares` / `purpose_shares`: written only by `share_resource` (now accepting `'group'`), cap 10 under a row lock, delete direct under RLS, disabled owner hidden, demo excluded, no notification.
2. **RLS through the existing helper pattern.** `shared_group_ids()` gains a group-share branch and checks the group owner (not the trip owner) for activity; new `writable_group_ids()` backs write policies on `travel_groups` and `group_entries`. A group seen only through a shared trip stays read-only and not usable.
3. **Owner-only parts of a group are guarded by a trigger**, as trip columns are: non-owners cannot set, move, add or delete `is_self`, and cannot delete or invalidate an entry linked to someone else. Entries a grantee inserts take the owner's `owner_id` in a `before insert` trigger.
4. **Links are a column plus two guarded functions.** `group_entries.linked_user_id` (no column grant, unique per group and user, only on named non-self members) is written only by `claim_group_entry` / `unclaim_group_entry`, which take `auth.uid()` and change nothing else. Triggers on `group_shares`, `trip_shares` and `trips.group_id` clear a link once its user has no path to the group left; a disabled owner only hides it.
5. **A link is a label.** It never replaces typed data. Its only effect on computed values is "about my age" on the linked user's own trips, where the linked entry's own age wins and the user's profile birthdate is only the fallback.
6. **Two age anchors instead of one birthdate.** `is_self` always means the group owner; "about my age" means the trip owner when they own the group or linked an entry, else the group owner. The anchors come from rows (trip owner profile, group owner profile, link state), never from the actor, so a plan's input and hash stay independent of who presses the button. Every existing trip has the same owner for trip and group, so no existing hash changes.
7. **Shared groups can be used for own trips and searches** with the purpose pattern: plain FK plus a usable-by trigger on `trips.group_id` and `destination_searches.group_id`; unshare or leave clears the references and outdates the plans.
8. **The owner's birthdate is shown to recipients** on the `is_self` entry (Alex), on shared groups and shared trips. It leaves the server only when the group has an `is_self` entry; otherwise at most the owner's age.
9. **Group saves get an optimistic `updated_at` check** through a defaulted fourth argument of `replace_group_entries`.
10. **The migration ships alone, before the server code.** Without group shares the new policies add nothing; the server PR adds the access checks and the owner-id fix for the parse cache in the same deploy that allows `"group"` as a share resource.

## Consequences
- **Privacy:** recipients, and transitively the people a recipient shares their own trip with, see names and birthdates of everyone in the group, including the owner's profile birthdate (Alex). Both share notices say so before the button. This reverses ADR 0010's "the owner's own profile birthdate is not shown" and drops the `birthdateForAge` stand-in on shared trips.
- A link is self-declared and immediate; the owner sees it with the person's name and can remove it. Nothing but "about my age" on the claimer's own trips depends on it, so a wrong claim does little harm.
- Write grantees can change data describing other people (names, birthdates, notes) but not who "me" is and not other people's linked entries.
- `trips` and `destination_searches` lose their same-owner group FK in favour of a trigger; pgTAP covers owner, both levels, trip-only view, disabled owner and stranger.
- Link pruning runs in triggers, including inside cascades (group delete, account delete, trip delete); each path has a pgTAP case.
- One more secret-key profile read (two columns) per plan run when the trip owner uses someone else's group, always after RLS showed the group.
- CLAUDE.md ground rule 6 needs a one-line extension (spec section 7).
- Open choices (transitive linking, deleting linked entries, the fallback for "about my age", the plan's "self" label) are listed as Q1 to Q12 in the spec.
