# ADR 0009: One-off purpose typed into "Find destinations"

Status: accepted (Alex, 2026-11-02: the text is saved with the search and can be saved as a purpose afterwards; an unsaved one-off copies its text into the trip notes; 500 characters; CLAUDE.md unchanged) · Date: 2026-11-02 · Spec: `docs/specs/find-destinations.md` section 13 (decisions D16 to D22) · Issue #88 item 5

## Context
"Find destinations" starts only from a saved purpose, so trying an idea means creating a purpose first. Ground rule 3 says context is optional and should not force a step the user did not choose. Rule 2 allows one Haiku call per free-text purpose, cached, and no new kind of call. Search lists are owner-scoped and cached by a hash of the model input (ADR 0006). Purpose tags on `trip_purposes` are written by the server only. The app and the database deploy independently, so migrations must be additive.

## Decision
1. **The form offers saved purpose or typed text as one exclusive choice,** text trimmed 3 to 500 characters. Without saved purposes it opens in text mode instead of blocking.
2. **Typed text is tagged by the existing purpose-tags call, keyed by `purposeTagsHash` of the text alone.** Earlier searches and saved purposes with the same hash are read first, so the same text is tagged once.
3. **Storage is three nullable columns on `destination_searches`:** `purpose_text` (user-writable) and `purpose_tags` / `purpose_tags_hash` (secret key only, like `parsed_*`). "Exactly one of purpose id or text" is checked at input, not by a CHECK, because a deleted purpose and a saved one-off both break it legitimately.
4. **The list hash stays unchanged.** Identical model input from a text and from a saved purpose shares one list.
5. **"Save as purpose" copies text and tags, links the search, and never calls the LLM.** It is idempotent: an already linked search or an identical existing purpose is returned, and a lost race deletes its own insert.
6. **A card from an unsaved one-off prefills the trip notes with the typed text** and leaves the purpose empty. The text is the user's own words, unlike the AI reason, which stays out of notes.

## Consequences
- No prompt version, model input or saved list changes. Only one migration and one new route.
- A typed text and a saved purpose with identical input show the label of whichever made the list first.
- Tags made for a text whose list was then served from an older hash are not stored and are paid again next time (rare).
- A trip from an unsaved one-off has no purpose, so interest-based place facts (golf courses, beaches) are not fetched for its plan until the user saves the purpose and picks it.
- On the shared demo account typed texts are visible to other demo visitors; the form says so.
- The typed text is deleted with its list (newest 10, 90 days) unless the user saves it as a purpose.
