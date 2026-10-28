-- DB-side cap of 100 items per trip (mirrors MAX_ITEMS_PER_TRIP in the app). SECURITY INVOKER: RLS lets
-- the owner count their own trip's items. Error code TP100 is mapped to `limit_reached` in items.ts.
create or replace function public.trip_items_enforce_cap()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if (select count(*) from public.trip_items where trip_id = new.trip_id) >= 100 then
    raise exception 'trip item limit reached' using errcode = 'TP100';
  end if;
  return new;
end;
$$;

drop trigger if exists trip_items_cap on public.trip_items;
create trigger trip_items_cap before insert on public.trip_items
  for each row execute function public.trip_items_enforce_cap();
