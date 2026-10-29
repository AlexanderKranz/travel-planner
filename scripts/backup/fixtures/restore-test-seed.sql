-- Tiny synthetic data set for the restore-test dry run (scripts/backup/synthetic-backup.sh).
-- Fake users only (example.invalid). Runs against a LOCAL throwaway Supabase, never production.
-- The signup trigger creates the profiles; the composite foreign keys (group/trip + owner) are exercised.
insert into public.signup_allowlist (email) values ('restore-a@example.invalid'), ('restore-b@example.invalid');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('aaaaaaaa-1111-4000-8000-000000000001', 'restore-a@example.invalid', '{"locale":"en"}', 'authenticated', 'authenticated'),
  ('bbbbbbbb-1111-4000-8000-000000000002', 'restore-b@example.invalid', '{}',              'authenticated', 'authenticated');
insert into public.travel_groups (id, owner_id, name) values
  ('a1000000-1111-4000-8000-0000000000a1', 'aaaaaaaa-1111-4000-8000-000000000001', 'Fixture group');
insert into public.group_entries (group_id, owner_id, kind, count) values
  ('a1000000-1111-4000-8000-0000000000a1', 'aaaaaaaa-1111-4000-8000-000000000001', 'composition', 4);
insert into public.trip_purposes (id, owner_id, name) values
  ('a1000000-1111-4000-8000-0000000000b1', 'aaaaaaaa-1111-4000-8000-000000000001', 'Fixture purpose');
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days, group_id, purpose_id) values
  ('a1000000-1111-4000-8000-0000000000c1', 'aaaaaaaa-1111-4000-8000-000000000001', 'freetext', 'Fixture trip A1', 5,
   'a1000000-1111-4000-8000-0000000000a1', 'a1000000-1111-4000-8000-0000000000b1'),
  ('b1000000-1111-4000-8000-0000000000c2', 'bbbbbbbb-1111-4000-8000-000000000002', 'freetext', 'Fixture trip B1', 3, null, null);
insert into public.plans (trip_id, owner_id) values
  ('a1000000-1111-4000-8000-0000000000c1', 'aaaaaaaa-1111-4000-8000-000000000001');
insert into public.trip_items (owner_id, trip_id, category, title) values
  ('aaaaaaaa-1111-4000-8000-000000000001', 'a1000000-1111-4000-8000-0000000000c1', 'stay', 'Fixture hotel');
