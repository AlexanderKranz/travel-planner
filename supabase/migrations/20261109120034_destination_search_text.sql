-- One-off purpose typed into "Find destinations" (docs/specs/find-destinations.md section 13.3, ADR 0009).
-- Additive only: the running app keeps working with the extra columns; the old app reads such a row like a list
-- whose purpose was deleted. Deploy order: this migration first.

alter table public.destination_searches
  add column if not exists purpose_text      text,
  add column if not exists purpose_tags      jsonb,
  add column if not exists purpose_tags_hash text;

alter table public.destination_searches
  drop constraint if exists destination_searches_purpose_text_check,
  drop constraint if exists destination_searches_purpose_tags_check,
  drop constraint if exists destination_searches_purpose_tags_hash_check,
  drop constraint if exists destination_searches_purpose_tags_pair;
alter table public.destination_searches
  -- Stored trimmed. Clients hold insert and update grants on purpose_text, so the DB must not rely on Zod's .trim().
  -- \s covers newlines and tabs; ^ and $ match only at the start and end of the string, so inner line breaks are fine.
  add constraint destination_searches_purpose_text_check check (
    purpose_text is null
    or (char_length(purpose_text) between 3 and 500 and purpose_text !~ '^\s' and purpose_text !~ '\s$')
  ),
  add constraint destination_searches_purpose_tags_check check (
    purpose_tags is null or (jsonb_typeof(purpose_tags) = 'object' and pg_column_size(purpose_tags) < 16384)
  ),
  add constraint destination_searches_purpose_tags_hash_check check (
    purpose_tags_hash is null or purpose_tags_hash ~ '^[0-9a-f]{64}$'
  ),
  add constraint destination_searches_purpose_tags_pair check ((purpose_tags is null) = (purpose_tags_hash is null));

-- Tag lookup by hash (spec 13.2 step 1).
create index if not exists destination_searches_tags_hash_idx
  on public.destination_searches (owner_id, purpose_tags_hash)
  where purpose_tags_hash is not null;

-- purpose_text joins the insert and update grants (claimRound1 takes over a row in place, and a served row is relabelled).
-- purpose_tags and purpose_tags_hash get NO insert or update grant: like trip_purposes.parsed_* they are written only
-- with the secret key, because "Save as purpose" copies them without a new LLM call. Select stays table-wide.
grant insert (purpose_text) on public.destination_searches to authenticated;
grant update (purpose_text) on public.destination_searches to authenticated;
