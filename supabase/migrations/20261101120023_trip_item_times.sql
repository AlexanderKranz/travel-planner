-- Optional local start/end time (HH:MM at the destination) on trip items. Spec docs/specs/timed-items.md [D1].
-- Text with a strict HH:MM check (not `time`): the app, the plan JSON and the LLM input all use HH:MM strings.
-- end_time needs a start_time. end_time < start_time is allowed (a flight or dinner that ends after midnight) [D2].

alter table public.trip_items
  add column if not exists start_time text,
  add column if not exists end_time text;

alter table public.trip_items drop constraint if exists trip_items_start_time_check;
alter table public.trip_items add constraint trip_items_start_time_check
  check (start_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.trip_items drop constraint if exists trip_items_end_time_check;
alter table public.trip_items add constraint trip_items_end_time_check
  check (end_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$');
alter table public.trip_items drop constraint if exists trip_items_end_needs_start;
alter table public.trip_items add constraint trip_items_end_needs_start
  check (end_time is null or start_time is not null);

-- Column grants follow migration 19: the owner may write both new columns.
grant insert (start_time, end_time) on public.trip_items to authenticated;
grant update (start_time, end_time) on public.trip_items to authenticated;
