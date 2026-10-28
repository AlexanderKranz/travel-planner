-- Free-text group description (spec docs/specs/group-text.md). A travel group is a name plus a free text
-- ("Wir sind 5 Freunde, alle in meinem Alter"); Haiku turns it into travellers once per text change, cached by text
-- hash like trip_purposes.parsed_*. The structured editor (group_entries) stays and wins over the text.
-- A trip can also carry a one-off group text of its own (no saved group): trips.group_text, mutually exclusive with
-- group_id, plus the user's corrected structure (group_structure, user-writable) and the Haiku cache (group_parsed*).

-- ---------- travel_groups ----------
alter table public.travel_groups
  add column if not exists description       text check (char_length(description) <= 1000),
  add column if not exists parsed_structure  jsonb check (parsed_structure is null or pg_column_size(parsed_structure) < 16384),
  add column if not exists parsed_hash       text,
  add column if not exists parsed_at         timestamptz;

-- Column grants: description is user-writable; parsed_* only by the server with the secret key.
grant insert (name, notes, trait_keys, description) on public.travel_groups to authenticated;
grant update (name, notes, trait_keys, description) on public.travel_groups to authenticated;

-- ---------- trips ----------
alter table public.trips
  add column if not exists group_text         text check (char_length(group_text) <= 1000),
  add column if not exists group_structure    jsonb check (group_structure is null
    or (jsonb_typeof(group_structure) = 'array' and jsonb_array_length(group_structure) <= 30 and pg_column_size(group_structure) < 16384)),
  add column if not exists group_parsed       jsonb check (group_parsed is null or pg_column_size(group_parsed) < 16384),
  add column if not exists group_parsed_hash  text,
  add column if not exists group_parsed_at    timestamptz;

-- A trip has a saved group OR a one-off description, never both.
alter table public.trips drop constraint if exists trips_group_exclusive;
alter table public.trips add constraint trips_group_exclusive
  check (group_id is null or (group_text is null and group_structure is null));
-- A corrected structure belongs to a text.
alter table public.trips drop constraint if exists trips_group_structure_needs_text;
alter table public.trips add constraint trips_group_structure_needs_text
  check (group_structure is null or group_text is not null);

grant insert (group_text, group_structure) on public.trips to authenticated;
grant update (group_text, group_structure) on public.trips to authenticated;

-- ---------- ai_usage: new task for the Haiku group parse ----------
alter table public.ai_usage drop constraint if exists ai_usage_task_check;
alter table public.ai_usage add constraint ai_usage_task_check
  check (task in ('purpose_tags', 'group_parse', 'plan_generate', 'plan_patch'));

-- ---------- replace_group_entries ----------
-- Same as 20261028120010, plus description from p_group ({"name", "notes", "description", "trait_keys": text[]}).
-- A p_group without a "description" key keeps the stored description.
create or replace function public.replace_group_entries(p_group_id uuid, p_group jsonb, p_entries jsonb)
  returns void
  language plpgsql
  security invoker
  set search_path = ''
as $$
begin
  if p_entries is null or jsonb_typeof(p_entries) <> 'array' or jsonb_array_length(p_entries) > 30 then
    raise exception 'invalid_entries' using errcode = '22023';
  end if;

  update public.travel_groups
     set name = p_group ->> 'name', notes = p_group ->> 'notes',
         description = case when (p_group -> 'description') is not null then p_group ->> 'description' else description end,
         trait_keys = coalesce(array(select jsonb_array_elements_text(p_group -> 'trait_keys')), '{}')
   where id = p_group_id;
  if not found then
    raise exception 'group_not_found' using errcode = 'P0002';
  end if;

  -- Every given id must be an entry of this group and appear once.
  if exists (
       select 1 from jsonb_populate_recordset(null::public.group_entries, p_entries) r
        where r.id is not null
          and not exists (select 1 from public.group_entries e where e.id = r.id and e.group_id = p_group_id)
     )
     or exists (
       select 1 from jsonb_populate_recordset(null::public.group_entries, p_entries) r where r.id is not null group by r.id having count(*) > 1
     ) then
    raise exception 'invalid_entries' using errcode = '22023';
  end if;

  -- Delete first so a replaced "self" entry cannot collide with the unique index.
  delete from public.group_entries e
   where e.group_id = p_group_id
     and e.id not in (select r.id from jsonb_populate_recordset(null::public.group_entries, p_entries) r where r.id is not null);

  -- Updates in two passes (non-self first) so moving the "self" flag between entries does not
  -- trip the one-self-per-group unique index.
  update public.group_entries e
     set kind = r.kind, "position" = r."position", count = r.count, label = r.label, name = r.name,
         is_self = r.is_self, birthdate = r.birthdate, age_mode = r.age_mode, age = r.age,
         age_as_of = r.age_as_of, notes = r.notes, traits = r.traits
    from jsonb_populate_recordset(null::public.group_entries, p_entries) r
   where e.id = r.id and e.group_id = p_group_id and not r.is_self;
  update public.group_entries e
     set kind = r.kind, "position" = r."position", count = r.count, label = r.label, name = r.name,
         is_self = r.is_self, birthdate = r.birthdate, age_mode = r.age_mode, age = r.age,
         age_as_of = r.age_as_of, notes = r.notes, traits = r.traits
    from jsonb_populate_recordset(null::public.group_entries, p_entries) r
   where e.id = r.id and e.group_id = p_group_id and r.is_self;

  insert into public.group_entries
    (group_id, kind, "position", count, label, name, is_self, birthdate, age_mode, age, age_as_of, notes, traits)
  select p_group_id, r.kind, r."position", r.count, r.label, r.name, r.is_self, r.birthdate,
         r.age_mode, r.age, r.age_as_of, r.notes, r.traits
    from jsonb_populate_recordset(null::public.group_entries, p_entries) r
   where r.id is null;
end;
$$;

revoke execute on function public.replace_group_entries(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.replace_group_entries(uuid, jsonb, jsonb) to authenticated;
