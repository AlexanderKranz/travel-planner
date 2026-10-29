# Patch safety: shrink guard and edits without AI

Status: implemented on `fix/patch-shrink` (prompt `plan-5`).

## Bug

Copenhagen trip, plan-4. Day 1 had 6 activities (arrival, Torvehallerne lunch, Rathausplatz with alternatives
Københavns Rådhus + Jens Olsens Verdensur, nap, Strøget with alternative Amagertorv, dinner) and a tip. Free-text
feedback without selected days: "für tag 1. wir machen Rathausplatz und rådhus, aber machen nicht Verdensur. auch
Amagertorv streichen." The new version had only "ANREISE …" and "ESSEN Torvehallerne · Torvehallerne", no tip, and the
day was marked "Geändert".

## Root cause (evidence)

Reproduced live with a Copenhagen fixture (`src/lib/plan/__fixtures__/copenhagen.json`) and the real patch request
(`npm run evals:patch-shrink`, raw output in `evals/recorded/copenhagen.patch-stub.plan-4.json`):

| variant | scope | text | model output for day 1 |
| --- | --- | --- | --- |
| a | none | "Verdensur" | 2 acts, lunch `text: ""`, `alts: []`, no note (205 output tokens) |
| b | day 1 | "Verdensur" | same stub |
| c | none | "Jens Olsens Verdensur" | same stub, plus `summary: ""`, `notes: []`, `open: []` |
| d | day 1 | "Jens Olsens Verdensur" | 6 acts, but Rådhus moved into the Strøget slot and both alternatives of Rathausplatz lost |

1. **The model returns a stub day.** With the plan-4 patch rules ("return the days that change, each complete") Sonnet
   treated the patch as a diff: it copied the first activities, wrote an empty text for "unchanged" and stopped.
   CURRENT_PLAN was complete (refs and alts as `p` ids, texts, note), so the input was not the problem; the selected
   day scope and the exact place name made no difference.
2. **Code accepted it.** `applyPatch` replaces a day wholesale; nothing compared it with the base day.
3. **"Torvehallerne · Torvehallerne"**: the empty text fell back to the place name in `assembleDay`.
4. **Variant c would also have wiped the trip notes and open items**: `notes: []`/`open: []` replaced the lists.

Ruled out: normalizePlan/assembleDay dropping acts (the stub already had 2), alts dropped in `dayForModel` (all refs
were in the index), the fixed-item overlap guard (no fixed items; it never removes notes).

## Decisions

- **[D1] Prompt fix (plan-5).** PATCH_ADDENDUM now says a returned day replaces the stored day completely, every
  staying activity is copied with all fields, there is no shorthand for "unchanged", text is never empty, only what
  FEEDBACK asks for changes, dropping an alternative = same activity without that id, and summary/notes/open are
  omitted rather than sent empty. Live after the fix: 4/4 variants correct (6 acts, only the two alternatives gone,
  tip kept; `evals/recorded/copenhagen.patch-variants.json`). `PLAN_PROMPT_VERSION` bumped to `plan-5` (changes input
  hashes once).
- **[D2] The model output is never trusted to be complete.** Code guards stay even with the prompt fix.
- **[D3] Shrink guard** (`src/lib/plan/patch-guard.ts`, run in `iteratePlan` after `applyPatch`). A patched day that
  lost more than half of its activities, or all of them, is replaced by the base day unless the feedback has
  "redo_day" for that day or text clearly asking to clear it ("komplett", "freier Tag", "nur noch", "everything",
  "day off", …; "streichen" alone does not count). The rejection is never silent: the response carries
  `rejectedDays`, the client shows "Tag 1 wurde nicht geändert, weil die Antwort unvollständig war. Bitte erneut
  versuchen." (the model reply is dropped when nothing else changed, because it describes the rejected change), and
  `app_events` gets `plan.patch_shrink_rejected` (days, activity counts, cost). If no day is left changed, no version
  is written. The cost is already spent and logged in `ai_usage` as usual.
- **[D4] Day note/warn survive** a patch that drops them, unless the feedback mentions tips/notes/warnings or the day
  is redone. Logged as `keptNotes` in `plan.patched`.
- **[D5] Empty lists mean unchanged.** `applyPatch` ignores `notes: []`, `open: []` (and `summary: ""` as before).
- **[D6] Empty text with a ref** takes the base day's text for that place before falling back to the place name.
- **[D7] Edits without AI** (ground rule 2, the real fix for this use case). On the owner's latest, idle version each
  alternative gets "↑" (make it the main place) and "×" (remove), and each activity gets "×" (remove, inline
  confirmation) in the reserved action column next to the quick add "+" (stacked on phones, side by side from `sm`;
  hidden until hover/focus on hover devices, always visible on touch). They are `PlanEdit` kinds `remove_alt`,
  `promote_alt`, `remove_act` addressed by day/stop/activity index of the base version (the base-version check rejects
  stale addresses with `conflict`). Each creates a version of kind `edit` like swap days/best day: no LLM, no budget,
  rate limit 20/min per user, busy check, `plan.edited` event, unreferenced places pruned. The versions list shows
  "Ohne KI: Alternative entfernt" (`versionKinds.edit` is now "Ohne KI" / "Without AI").

- **[D8] The best day is set by the user only.** Alex does not want the AI to pick a highlight. Rule 10 no longer
  asks for `best`, `best` is gone from the wire schema, `LlmDay` and CURRENT_PLAN (fewer tokens; part of `plan-5`),
  and `assembleDay` never sets it. A day carries `best: true` plus `bestBy: "user"`, written only by the `set_best`
  edit; `isUserBest()` decides the badge and the dark card in the day card (app and share view) and in the PDF, so an
  AI `best` in plans stored before plan-5 stays hidden without a migration. `set_best` clears every other marker (also
  an old AI one), so there is at most one. A patched day keeps the base day's marker. The control is a star in the day
  card header (reserved column, hidden until hover/focus on hover devices, always visible on touch and when set):
  "Tag n als besten Tag markieren" / "Markierung „Bester Tag“ von Tag n entfernen". The "Bester Tag → Setzen"
  control in the "Ohne KI" panel is removed. The eval check is now "no best day from the model".

- **[D9] Time pills in the day card** (Alex's phone test; modelled on his hand-made Danube plan). A stop window is
  a rounded navy-tint pill after the place ("Passau · bis 16:00"; "ab 14:00", "14:00–23:59"), the "aus deinen
  Notizen" badge stays. Activity and fixed-item times are smaller pills of the same family (tokens `--time-bg` /
  `--time-fg`: #e6edf5 / #1f3a5f light ≈ 10:1, #243b5c / #dbe4f0 dark, white 14 % / cream on the best-day card;
  all ≥ 4.5:1). Phones: line 1 = time pill + category label, line 2 = text at full width. From `sm`: grid with a
  fixed time column (6.5rem, pills align), label column, text. Untimed activities have no pill. Fixed items use the
  same layout plus their status badge. Share view uses the same component; the PDF draws times and windows as
  rounded pills in the same colours (`C.timeBg`).
- **[D10] Short activity texts (plan-5).** Rule 1 asks for note phrases, not sentences: no articles or filler,
  ideally ≤ 50 characters ("Mittagsschlaf an Bord", "Trage statt Buggy (Kopfsteinpflaster)"), group hints in a
  short parenthesis or in note/warn, titles ≤ 40 characters. Code clamps (counted as `truncated`, never rejected):
  `LIMITS.text` 200 → 90, `LIMITS.title` 80 → 60. The stored schema keeps 200/80 so older plans stay valid.
  Measured on the recorded fixtures (plan-4 → plan-5, output tokens): cruise generate 3774 → 2349, golf generate
  2778 → 2482, cruise patch 619 → 545, golf patch 480 → 467; average activity text 38 → 29 characters. The cached
  system prefix grew by about 105 tokens (generation) and 270 tokens (patch, with the addendum of [D1]).

## Known limits

- The guard counts activities only. A patch that keeps the count but rewrites the wrong things (variant d with plan-4)
  passes; the version list and restore are the fallback.
- The free-text exemption is a keyword list (de + en). Other languages fall back to rejection, which is the safe side.
- Removing an activity is undone by restoring the previous version (no one-tap undo).
