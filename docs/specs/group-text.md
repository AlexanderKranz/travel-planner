# Travel group as free text (group-text)

Status: implemented on `feat/group-text`, decisions below await review. Alex approved the Haiku call explicitly;
it extends CLAUDE.md ground rule 2 (see the "Allowed LLM uses" list).

## Problem

A travel group needed a quick composition, named members or notes. Most trips are described faster in one
sentence: "Wir sind 5 Freunde, alle in meinem Alter", "Ich und Ben, ähnliches Alter". Like trip purposes, a group
should be describable in free text, while groups that are reused often (Familie) keep exact named members with
birthdates.

## What changed

- A group is a **name plus a free-text description**. The old editor (several people, named members, notes,
  relevant details) moved into the collapsed section "Personen genau angeben". Existing groups keep working.
- Haiku turns the text into structured travellers, once per text change, cached by text hash (same pattern as
  purpose tags). The result is shown under the text ("Erkannt: 5 Erwachsene, ca. 46") with "Anpassen".
- A trip can carry a **one-off group** (free text, same parse) instead of a saved group.
- Plan input, party size for costs and every display use one resolution (`resolveGroup`, `src/lib/group-text.ts`).

## Decisions to review

- **[D1] Group = name + `description` (main field).** `travel_groups.description` (text, max 1000, user-writable).
  The structured editor is a `<details>` that opens by itself when the group has entries or notes. Group notes
  moved into that section. Nothing is required except the name.
- **[D2] Haiku task `group_parse`**: model `claude-haiku-5-5`, effort low, max 800 tokens, system prompt
  `GROUP_RULES` (prompt version `group-1`), one block `TEXT {"text": ...}`. `zodOutputFormat` JSON schema, our own
  `safeParse` + `normalizeParse` (unknown modes/roles dropped, numbers clamped), usage in `ai_usage`
  (`task = 'group_parse'`, constraint extended in the migration), budget check (reserve 2000 micro-USD),
  `AI_ENABLED` kill switch, per-user rate limit (20/min). Failures log `group.parse_failed` (reason only, no text).
- **[D3] When it runs: on save**, in `createGroup`/`updateGroup`/`createTrip`/`updateTrip`, synchronously and best
  effort (never blocks or fails the save). Cache key = `groupTextHash(text)` (sha256 of prompt version and the
  whitespace-normalised text); the parse is used only when the stored hash matches the current text, so an edited
  text is never combined with an old parse. No preview call while typing (no hidden spend, no cache table).
  The recognised result therefore appears after saving: a new group opens on its edit page for this reason.
- **[D4] Parse model.** `{ v: 1, travellers: [{ count, ageMode?: exact|approx|relativeToMe, age?, ageOffset?,
  label?, role?: adult|child|infant }], notes: string[] }`. The wire schema has **every field required and
  nullable**: recorded runs with optional fields produced broken strings (`"role":"adult','label':'Freunde"`) and
  lost travellers; with required fields all 9 samples were clean. "alle in meinem Alter" is `relativeToMe` with
  offset 0; the writer's own age is `relativeToMe` too. It maps onto the existing composition-entry model for
  "Anpassen" (count, label, exact/approx/relativeToMe); only the offset has no equivalent (see D6).
- **[D5] Resolution order** (`resolveGroup`): saved entries (named members, or the structure the user corrected)
  > Haiku parse of the current text > raw text only. The "flag" that the user's structure wins is implicit: a
  group has saved entries or it has not (`entries.length > 0`), so there is no flag to keep in sync. A later text
  change creates a new parse; if entries exist they still win, the UI shows the new recognition and offers
  "Erkennung übernehmen" (replaces the entries in the form, saved only with Speichern). That button is hidden when
  the group has named members or "me", so they cannot be overwritten by accident. A parse with no travellers
  (text without people) counts as raw text.
- **[D6] Ages are computed, never stored.** `relativeToMe` = profile age on the travel date (`ageOn`) + offset,
  at least 0, marked approximate. Without a profile birthdate: offset 0 gives "ähnliches Alter wie du" and no age
  is sent to the plan; another offset gives unknown. "Anpassen" turns an offset into an approximate stated age
  (stored with `age_as_of` like all stated ages) when the birthdate is known, otherwise it stays "about my age" and
  the offset is dropped. Ages from the text (`exact`/`approx`) are the user's own statement; they are not advanced
  by time (the parse is tied to the text and renewed when the text changes).
- **[D7] No text, no AI, or a failed call:** the group still saves. It has no structure; the plan gets the raw
  text cut to 600 characters as `group.notes` (`size` 0, no entries, header badges hidden) and party size is
  unknown. Parse notes (mobility, diet) are appended to the group notes in the plan input; with entries and a
  parse, the parse notes are used, without a parse the cut raw text.
- **[D8] One-off group on the trip.** Trip form "Wer reist mit?": none, a saved group, or "Nur für diese Reise
  beschreiben …" (free text). Columns on `trips`: `group_text` (max 1000), `group_structure` (user-corrected
  composition entries as a jsonb array, with server-set `ageAsOf`), `group_parsed`, `group_parsed_hash`,
  `group_parsed_at`. Checks: `group_id` and `group_text`/`group_structure` are mutually exclusive
  (`trips_group_exclusive`), a structure needs a text. The Zod `TripInput` enforces the same, and a saved group
  always clears the text. Same parse, same resolution (`tripGroupSource`). Editing the structure uses the same
  entry editor as groups (several people only, no names).
- **[D9] Plan input and party size use one resolution.** `buildPlanInput` takes a `GroupContext` (a `TravelGroup`
  fits, a trip's one-off group is built from the trip); the plan's `group.size`, the header badges
  ("2 Erwachsene · 1 Kind"), the costs' party size (own page and share/PDF path) and the flights' adult count all
  come from `resolveGroup`. The entries path produces the same input as before, so existing plans, evals and hashes
  are unchanged; only groups/trips with text change the input hash. A parsed row without an age but with a role
  travels as `label: "child"`/`"infant"`/`"adult"`; the prompt shape did not change (`plan-4` stays).
- **[D10] Display.** Trip context strip: `Name · 5 Erwachsene, ca. 46` (one line, from the same resolution), the
  age list for entries/parse, the raw text (3 lines) when only text is known, and a link to the trip's edit page
  for a one-off group. Plan header badges, share view and PDF already show `plan.header.group`, which now comes
  from the resolution. The groups list shows the description (2 lines). All texts in `messages/{de,en}.json`
  (`groups.text`, `groups.exact`, `groups.summary`, `trips.form.groupText`).
- **[D11] DB and security.** Migration `20261101120024_group_text.sql`: new columns, explicit column grants
  (`description`, `group_text`, `group_structure` user-writable; `parsed_*` and `group_parsed*` have **no** grant),
  RLS untouched (owner policies), `replace_group_entries` writes `description` (a missing key keeps the stored
  text), `ai_usage` task constraint extended. The parse is written by the server with the secret key
  (`saveGroupParse`, filtered by `owner_id`, comment in code), like `savePurposeTags`. The share path
  (`getSharedPlanDocument`) reads only the columns the party size needs, explicit lists, and returns no text:
  the shared document contains counts and badges, never the description. pgTAP tests in `supabase/tests/rls.test.sql`.
- **[D12] Recorded fixtures.** `npm run evals:group-text` (live, ledger-guarded) records the raw Haiku output of 9
  sample texts to `evals/recorded/group-text.json`; unit tests replay them through `normalizeParse` and
  `resolveGroup`. Findings that shaped the prompt: optional fields broke decoding (D4); the writer was left
  without an age ("Ich fahre allein") until the rules said the writer is `relativeToMe` 0; "45 und 43" was merged
  into one item until the rules said different ages are separate items. Remaining known limit: Haiku sometimes adds
  a note that repeats an age; users correct with "Anpassen".

## Not done

- No live preview while typing, no lazy parse at plan time (a group saved while AI was off is parsed on its next
  save). The plan then uses the raw text, which is the specified fallback.
- The one-off group's recognised result is shown on the trip edit page and in the trip context strip, not live in
  the form before the first save.
- Locale: labels from Haiku are in the language of the text; notes in English. Plan prose stays in the user's locale.
