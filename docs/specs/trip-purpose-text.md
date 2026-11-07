# One-off trip purpose as free text (trip-purpose-text, issue #150)

Status: spec, decisions below await review. Mirrors the one-off group (`docs/specs/group-text.md` [D8] to [D10]) and
reuses the typed search purpose (`docs/specs/find-destinations.md` section 13). No new LLM use: the text is tagged by
the existing Haiku task `purpose_tags` (CLAUDE.md ground rule 2, "Haiku turns free-text purposes into structured tags,
once per purpose, cached"). CLAUDE.md needs no new line under "Allowed LLM uses".

## Problem

The trip form's purpose select offers "none" or a saved purpose. A purpose used once ("Mamas 70. Geburtstag, ein
gutes Abendessen, sonst ruhig") should not have to become a saved purpose first. The group select already has
"Nur für diese Reise beschreiben …"; the purpose select gets the same option: text only, no guided fields, no
constraints.

## Decisions to review

- **[P1] Form.** Purpose select: none, saved purposes (own, then "Shared with me" optgroup), last option
  `trips.form.purposeOneOff` ("Nur für diese Reise beschreiben …" / "Describe just for this trip …"). Choosing it shows
  one textarea (4 rows, `maxLength` 4000) with label and hint, nothing else. Client draft: `purposeId` is `""`,
  `ONE_OFF_PURPOSE = "__text"` or a uuid (as `ONE_OFF_GROUP` in `trip-draft.ts`); `purposeText` lives in the draft
  and survives switching the select (only the active source is sent). Selecting the option with an empty text sends
  nothing (= no purpose), like an empty one-off group. Nothing becomes required (ground rule 3).

- **[P2] Columns on `trips`** (migration `20261113120038_trip_purpose_text.sql`, additive):

  | Column | Type | Null | Check / note |
  |---|---|---|---|
  | `purpose_text` | text | yes | `char_length(purpose_text) between 1 and 4000 and purpose_text !~ '^\s' and purpose_text !~ '\s$'` (stored trimmed, checked in the DB because clients hold the column grant; same reasoning as find-destinations 13.3). 4000 = `TripPurposeInput.text`, so the text could become a saved purpose unchanged. |
  | `purpose_tags` | jsonb | yes | `jsonb_typeof = 'object' and pg_column_size < 16384` |
  | `purpose_tags_hash` | text | yes | `~ '^[0-9a-f]{64}$'`; `(purpose_tags is null) = (purpose_tags_hash is null)` |
  | `purpose_tags_at` | timestamptz | yes | set with the tags |

  - `trips_purpose_exclusive`: `check (purpose_id is null or purpose_text is null)`. Unlike `destination_searches`
    a CHECK is safe here: every path that touches `purpose_id` (`on delete set null`, `purpose_share_removed`) only
    clears it.
  - Grants: `purpose_text` joins the insert and update column grants of `authenticated`. `purpose_tags*` get **no**
    grant (server writes them with the secret key, like `group_parsed*` and `trip_purposes.parsed_*`), so nobody
    can plant tags that look machine-made.
  - `private.trips_owner_only()` (`create or replace`): add `or new.purpose_text is distinct from old.purpose_text`.
    The text is owner-only like `purpose_id` (sharing [D3]). Tags are not listed: they are written with the secret
    key (`auth.uid()` null passes).
  - RLS: unchanged. The new columns sit on `trips`, whose owner and grantee policies already decide row visibility;
    a grantee who may read the trip may read its one-off purpose (the same as reading a saved purpose through
    `shared_purpose_ids()`). No `private.*` helper change: there is no second table to reach.
  - No index: the tag lookup (P4) reads at most 30 trips per owner through the existing owner index.
  - `ai_usage` task constraint unchanged (`purpose_tags` exists).
  - Deploy order: migration first. The old app selects explicit columns and never writes `purpose_text`. Only an
    old-app save that sets `purpose_id` on a trip that already has a text fails (`trips_purpose_exclusive`, mapped to
    `failed`); possible only in the deploy window, acceptable.

- **[P3] Zod `TripInput`.** `purposeText: optionalText(TRIP_PURPOSE_TEXT_MAX)` with `TRIP_PURPOSE_TEXT_MAX = 4000`
  exported from `src/lib/domain/purpose.ts` and also used by `TripPurposeInput.text` (not to be confused with the
  search's `PURPOSE_TEXT_MAX = 500` in `destination-search.ts`). `superRefine`: `purposeId` and `purposeText`
  together is an issue on `purposeText` ("Either a saved purpose or a one-off purpose"). `buildTripWrite`:
  `purpose_text: input.purposeId ? null : (input.purposeText ?? null)`, so a saved purpose always clears the text
  (defence in depth, as `group_text`). `updateTrip` for a non-owner keeps `purpose_text: before.purpose_text` next to
  `purpose_id`. `factsInputsChanged` also compares `purpose_text` (it decides the places, so a change re-warms).
  `eventProps` gets `hasPurposeText` (boolean, never the text).

- **[P4] Tagging: same call, same hash, after the response.**
  - Same task `purpose_tags`, `tagsRequest`/`tagPurpose`, `TAGS_RULES`, `MODEL_TAGS`, `finishTags`. The text runs as
    the transient purpose `oneOffPurpose(text, null)` (`src/lib/discover/one-off.ts`). Hash = `oneOffTagsHash(text)`,
    which equals `purposeTagsHash` of a saved purpose with the same text and the `purpose_tags_hash` of a typed search.
  - **When:** triggered by `createTrip`/`updateTrip`, but run in `scheduleTripWarm` (after the response, the same step
    that tags a saved purpose before warming places, `warm.ts withTags`), not synchronously as group-text [D3] does.
    Reason: a tags call takes several seconds (up to 3000 output tokens), the tags are not shown in the form (unlike
    the group's "Erkannt: …"), and the warm step needs them first anyway. The plan pipeline also tags when tags are
    missing (step 3, exactly like `wantsTags` for a saved purpose), because tags select the places (golf courses,
    activities); a trip saved while AI was off is tagged on its next plan run.
  - **Lookup before Haiku** (owner only, user session): `findTagsByHash(sb, hash, userId)` gets a third source,
    the owner's `trips` with `purpose_tags_hash = hash` (`from: "trip"`). Order: searches, purposes, trips. A hit is
    copied to the trip without a call. This makes the search prefill (P8) free. A write grantee (tagging during
    their plan run) skips the lookup: they cannot read the owner's searches; the call is charged to them, as for a
    shared purpose.
  - **Save:** `saveTripPurposeTags(trip: {id, ownerId}, tags, hash)` in `src/lib/server/trip-purpose-text.ts`, secret
    key, filtered by `id` and the row's `owner_id` (comment in code, like `saveGroupParse`), returns the new
    `updated_at`. The write moves `trips.updated_at` (trigger); the pipeline continues with the returned value for both
    `trip.updatedAt` and the purpose's `updatedAt`, so the plan basis stays current (same as `tagAndSave`). Side effect:
    an edit form opened before a background tag write reports `conflict` on save; the existing conflict notice covers it.
  - **Read:** `rowToTrip` sets `purposeTags` only when `purpose_tags_hash === oneOffTagsHash(purpose_text)` and
    `PurposeTags.safeParse` succeeds; else undefined. An edited text is never combined with old tags. Stale tags stay on
    the row until the next tag write (harmless, as `group_parsed`).
  - **Gates and logging:** `isAiEnabled`, budget (`RESERVE_TAGS`), usage in `ai_usage` charged to the actor
    (`logAiUsage` through `ctx.onUsage`). Failure never fails the save or the plan run: `purpose.tag_failed` with
    `{ source: "trip_text", tripId, reason }` (no text), then the fallback below.
  - **Fallback without tags:** `purposeInput` already sends the raw text cut to `FALLBACK_SUMMARY_CHARS` (600) as
    `summary` and selects places from the default interests. No change needed.

- **[P5] One resolution: `tripPurpose(trip, saved)`** in `src/lib/purpose-source.ts` (pure):
  ```ts
  /** The purpose a trip uses: the saved one (by purposeId), else its one-off text, else null. */
  export function tripPurpose(
    trip: Pick<Trip, "ownerId" | "access" | "purposeId" | "purposeText" | "purposeTags" | "updatedAt">,
    saved: TripPurpose | null,
  ): TripPurpose | null;
  // one-off: { ...oneOffPurpose(text, tags ?? null), ownerId: trip.ownerId, access: trip.access, usable: false,
  //            createdAt: trip.updatedAt, updatedAt: trip.updatedAt }   (id stays "")
  export const isOneOffPurpose = (p: TripPurpose) => p.id === "";
  ```
  Used by `loadPlanContext` (pipeline input, facts, places retries, `drivePicks`), `scheduleTripWarm`, the trip page
  (`SummaryPanel`, `GlancePanel`, header, `SharedContext`) and the edit page. In the pipeline the tag step branches on
  `isOneOffPurpose`: `tagTripPurpose` (P4) instead of `tagAndSave`.
  - **Input hash:** trips with a saved purpose or none produce exactly the same `PlanInput` as before, so existing
    versions, evals and hashes are unchanged; `PLAN_PROMPT_VERSION` stays. A trip with a one-off text gets a
    `purpose` block (`name` = `oneOffLabel(text)`, tags or the 600-char fallback) and therefore a new hash; a text edit
    or new tags change it again. `header.purposeName` = the same label; `basis.purposeUpdatedAt` = `trip.updatedAt`
    (as the one-off group's `groupUpdatedAt`).
  - **Destination search:** consumes no trip purpose (its form sends `purposeId` or its own `purposeText`). The only
    links are the shared tag cache (P4) and the prefill (P8). No change to `IdeaInput` or its hash.

- **[P6] Display.**
  - Trip page header eyebrow and trip card chip: the label (`oneOffLabel`), in the slot of the saved purpose name.
    `rowToSummary`: `purposeName = trip_purposes?.name ?? (purpose_text ? oneOffLabel(purpose_text) : null)`.
    `listSharedWithMe` gets it through `TRIP_COLUMNS`.
  - Edit page (owner): the select on the one-off option with the text in the textarea.
  - Shared trip, read and write grantees: `SharedContext` shows the purpose block as for a saved purpose: label as
    title, full text below, no "open purpose" link (`usable: false`). The write grantee's form shows it in
    `ownerOnlyValues.purpose` (label) under "Only {name} can change the group and purpose"; the server keeps the stored
    text whatever the form sends (P3) and the trigger rejects a change (P2).
  - Public share link and PDF: only `plan.header.purposeName` (the label), as a saved purpose's name today. The full
    text is never in the shared document (`getSharedPlanDocument` reads explicit columns; no change).

- **[P7] i18n** (`messages/de.json` + `en.json`, same keys):

  | Key | de | en |
  |---|---|---|
  | `trips.form.purposeOneOff` | Nur für diese Reise beschreiben … | Describe just for this trip … |
  | `trips.form.purposeText.label` | Wofür ist diese Reise? | What is this trip for? |
  | `trips.form.purposeText.hint` | In eigenen Worten, z. B. „Golf mit einem Freund, flache Plätze, gutes Essen“. Gilt nur für diese Reise. | In your own words, e.g. "Golf with a friend, flat courses, good food". Only for this trip. |
  | `trips.form.purposeFromSearch` | Dein eingetippter Zweck aus der Zielsuche steht hier. Auf der Vorschlagsseite kannst du ihn als Reisezweck speichern. | Your typed purpose from the destination search is filled in here. Save it as a purpose on the suggestions page to reuse it. |

  `trips.form.notesFromSearch` is removed once unused. Errors reuse `invalid`.

- **[P8] Prefill from a destination search: the typed text becomes the one-off purpose, notes stay empty.**
  Supersedes find-destinations [D21] (13.5), which put the text into `notes` because the trip had nowhere else for it.
  Reasons: it is a purpose, so it now gets tags and place selection (golf courses, activities); `notes` go verbatim to
  the plan and are never tagged. The tags come from the search row by hash without a Haiku call (P4). Limits fit
  (search 500, trip 4000). `buildTripDraft`: for an unsaved one-off (`purposeId === null && purposeText`) set
  `purposeId: ONE_OFF_PURPOSE, purposeText` instead of `notes`. A saved or linked purpose is unchanged. The form shows
  `purposeFromSearch` under the textarea instead of opening notes. find-destinations 13.5 gets a one-line
  "superseded by trip-purpose-text [P8]" note in the same PR.

## Tests

- **Unit:** `TripInput` rejects `purposeId` + `purposeText`, trims, max 4000, empty = absent; `buildTripWrite` clears
  the text for a saved purpose; non-owner `updateTrip` keeps `purpose_text`; `factsInputsChanged` on a text change;
  `rowToTrip` drops tags with a stale hash or invalid JSON; `rowToSummary` label fallback; `tripPurpose` (saved wins,
  one-off fields, null); `findTagsByHash` order searches > purposes > trips, no Haiku call on a hit; warm and
  pipeline tag a one-off once, save with the owner's id, charge the actor, use the returned `updated_at`; tag failure
  logs `purpose.tag_failed` `{source: "trip_text"}` and the plan still builds with the 600-char fallback;
  `buildPlanInput` for a saved-purpose trip is byte-identical to before (hash unchanged), a one-off trip equals the
  same saved purpose except `purpose.name`; `buildTripDraft` puts an unsaved typed text into `purposeText`, never into
  notes; `trip-draft` round trip of `ONE_OFF_PURPOSE`.
- **Eval (CI, no network):** Costa del Sol golf fixture with its purpose text as a one-off and the recorded tags gives
  the same places and the same `PlanInput` apart from `purpose.name`.
- **pgTAP** (`supabase/tests/rls.test.sql`, `sharing.test.sql`): `trips_purpose_exclusive` rejects both set;
  leading/trailing whitespace and length 4001 rejected, inner line break accepted; `authenticated` cannot write
  `purpose_tags`, `purpose_tags_hash`, `purpose_tags_at`; tags without hash rejected; a write grantee changing
  `purpose_text` gets 42501, changing the title still works; a read grantee reads `purpose_text`, a stranger reads no
  row; deleting or unsharing a saved purpose still clears `purpose_id` without violating the check.
- **E2E** (Playwright, 360 px and desktop): create a trip with "Describe just for this trip …", text shown on the
  edit page and as label in the header and trips list; switch to a saved purpose, save, text gone; write grantee sees
  the text read-only and cannot change it; from a typed destination search, the new-trip form opens with the one-off
  option and the text, notes empty.

## Implementation steps

**backend-dev**
1. Migration [P2] incl. `trips_owner_only`, grants, checks; pgTAP tests.
2. Domain: `TRIP_PURPOSE_TEXT_MAX`, `TripInput` [P3], `Trip.purposeText`/`purposeTags`; `TRIP_COLUMNS` adds
   `purpose_text, purpose_tags, purpose_tags_hash`; `rowToTrip`, `rowToSummary`, `buildTripWrite`,
   `factsInputsChanged`, `updateTrip` non-owner keep, `eventProps`.
3. `src/lib/purpose-source.ts` [P5]; `src/lib/server/trip-purpose-text.ts` (`saveTripPurposeTags`, `tagTripPurpose`
   with lookup and fallback logging); `findTagsByHash` trips source.
4. Wire `tripPurpose` into `loadPlanContext`, the pipeline tag step, `scheduleTripWarm`; unit tests and the eval.

**frontend-dev** (after step 2 lands)
5. `trip-draft.ts` (`ONE_OFF_PURPOSE`, `purposeText`, `draftFromTrip`/`draftToInput`), `trip-form.tsx` option and
   textarea [P1], `buildTripDraft` and `trips/new` hint [P8], find-destinations 13.5 note.
6. Display [P6]: header eyebrow and `SharedContext` via `tripPurpose` on the trip page, `ownerOnlyValues` on the
   edit page, trip card.
7. i18n [P7], remove `notesFromSearch`; E2E at 360 px and desktop.

## Not done

- No "save as purpose" from a trip (the text can be copied to a new purpose by hand; a button is a follow-up).
- No guided fields or constraints for the one-off (by design: text only).
- No tags preview in the form; nothing about the tags is shown to the user, as for saved purposes.

## Implementation notes (backend)

Steps 1 to 4 are in. Differences and additions to the text above:

- **Other readers of the trip purpose.** Besides `loadPlanContext`, `scheduleTripWarm`, the trip page and the edit page,
  the three routes that load the purpose by `purposeId` (`/api/trips/[id]/flights`, `.../flights/nearby`, `.../places`)
  now resolve it with `tripPurpose` too, so the flight limit and the places match the plan.
- **Plan basis after a tag write.** The pipeline's tag step replaces `ctx.trip.updatedAt` with the value returned by
  `saveTripPurposeTags` and, for a one-off *group* (no `groupId`), `ctx.group.updatedAt` too: that group's `updatedAt` is
  the trip's, so leaving it stale would make every new plan "outdated" at the next load.
- **`wantsTripTags`** (in `trip-purpose-text.ts`) is the one-off counterpart of `wantsTags`; it is checked first, because
  `wantsTags` is also true for the transient purpose (id `""`) and must never reach `tagAndSave`.
- **Lookup failure** in `tagTripPurpose` fails closed (no Haiku call, `purpose.tag_failed` with `reason: "lookup_failed"`),
  like the destination search.
- **`findTagsByHash`** returns `from: "trip"` for the third source; the destination search's `tagsFrom` log field accepts it.
- **Eval** (`evals/trip-purpose-text.test.ts`) compares the one-off with the saved golf purpose *without constraints*: the
  fixture's constraint "max 3 h flight from FRA" sets the flight limit, a one-off has no constraints, so with them the
  flights block would differ. The text-only parts (places, drive times, group, items) are identical.
- **Not run locally:** the pgTAP additions (no Docker on the dev machine); they run in the CI job `db-test`.
