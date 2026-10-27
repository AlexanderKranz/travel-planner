-- Per-group trait selection: the group stores which optional entry details (traits) are relevant.
-- The app strips every entry's traits to these keys on save.

alter table public.travel_groups
  add column if not exists trait_keys text[] not null default '{}';

-- Adding a trait needs a migration here AND a new entry in TRAIT_KEYS (src/lib/domain/group.ts).
-- No subqueries allowed in CHECK: uniqueness = cardinality equals the number of distinct known keys present.
alter table public.travel_groups
  add constraint travel_groups_trait_keys_valid check (
    cardinality(trait_keys) <= 10
    and trait_keys <@ array['mobility', 'diet', 'golfHandicap', 'needsNap']
    and cardinality(trait_keys) =
      (case when 'mobility' = any (trait_keys) then 1 else 0 end
     + case when 'diet' = any (trait_keys) then 1 else 0 end
     + case when 'golfHandicap' = any (trait_keys) then 1 else 0 end
     + case when 'needsNap' = any (trait_keys) then 1 else 0 end)
  );

-- Backfill: existing groups keep the traits their entries already carry (otherwise the next save
-- would strip them). Ordered like TRAIT_KEYS. Factored into a function so pgTAP can test it.
create or replace function private.group_trait_keys_used(p_group_id uuid)
  returns text[]
  language sql
  stable
  set search_path = ''
as $$
  select coalesce(array_agg(k.key order by k.ord), '{}')
    from unnest(array['mobility', 'diet', 'golfHandicap', 'needsNap']) with ordinality as k(key, ord)
   where exists (
     select 1 from public.group_entries e
      where e.group_id = p_group_id
        and jsonb_typeof(e.traits -> k.key) not in ('null')
   );
$$;

update public.travel_groups g set trait_keys = private.group_trait_keys_used(g.id);

grant insert (name, notes, trait_keys) on public.travel_groups to authenticated;
grant update (name, notes, trait_keys) on public.travel_groups to authenticated;

-- Same as 20261027120006, plus trait_keys from p_group ({"name", "notes", "trait_keys": text[]}).
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
