-- One-off trip purpose as free text (docs/specs/trip-purpose-text.md [P2], issue #150).
-- Forward-only and additive. Deploy this migration first: the old app selects explicit columns and never writes
-- purpose_text. (Only an old-app save that sets purpose_id on a trip that already has a text fails with
-- trips_purpose_exclusive; possible only in the deploy window.)

alter table public.trips
  -- Stored trimmed (checked here because clients hold the column grant): 1..4000 characters, no leading or trailing
  -- whitespace. 4000 = TripPurposeInput.text, so the text could become a saved purpose unchanged.
  add column if not exists purpose_text        text check (
    char_length(purpose_text) between 1 and 4000 and purpose_text !~ '^\s' and purpose_text !~ '\s$'),
  -- Haiku tags of the text, written by the server only (no column grant, like group_parsed).
  add column if not exists purpose_tags        jsonb check (
    purpose_tags is null or (jsonb_typeof(purpose_tags) = 'object' and pg_column_size(purpose_tags) < 16384)),
  add column if not exists purpose_tags_hash   text check (purpose_tags_hash is null or purpose_tags_hash ~ '^[0-9a-f]{64}$'),
  add column if not exists purpose_tags_at     timestamptz;

-- Tags and their hash belong together.
alter table public.trips drop constraint if exists trips_purpose_tags_pair;
alter table public.trips add constraint trips_purpose_tags_pair
  check ((purpose_tags is null) = (purpose_tags_hash is null));

-- A trip has a saved purpose OR a one-off text, never both. A CHECK is safe: every path that touches purpose_id
-- (on delete set null, private.purpose_share_removed) only clears it.
alter table public.trips drop constraint if exists trips_purpose_exclusive;
alter table public.trips add constraint trips_purpose_exclusive
  check (purpose_id is null or purpose_text is null);

-- Only the text is user-writable. purpose_tags, purpose_tags_hash and purpose_tags_at get no grant: the server writes
-- them with the secret key, so nobody can plant tags that look machine-made.
grant insert (purpose_text) on public.trips to authenticated;
grant update (purpose_text) on public.trips to authenticated;

-- The text is owner-only like purpose_id (sharing spec D3). Same function as 20261110120035 plus purpose_text; the tags
-- are not listed because they are written with the secret key (auth.uid() is null and passes).
create or replace function private.trips_owner_only()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null or v_uid = old.owner_id or current_user <> 'authenticated' then
    return new;
  end if;
  if new.group_id is distinct from old.group_id
     or new.group_text is distinct from old.group_text
     or new.group_structure is distinct from old.group_structure
     or new.purpose_id is distinct from old.purpose_id
     or new.purpose_text is distinct from old.purpose_text then
    raise exception 'owner_only' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.trips_owner_only() from public, anon, authenticated;
