-- pgTAP tests for durable AI call limits (migration 20261115120040). Run with `supabase test db`.
-- One transaction, rolled back. now() is constant inside it, so slots are aged by updating created_at.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

insert into public.signup_allowlist (email) values ('a@slots.test');
insert into auth.users (id, email, raw_user_meta_data, aud, role) values
  ('5c000000-0000-4000-8000-0000000000a1', 'a@slots.test', '{}', 'authenticated', 'authenticated');

-- ---------- grants and RLS: service role only ----------
select ok((select relrowsecurity from pg_class where oid = 'public.ai_call_slots'::regclass), 'RLS enabled on ai_call_slots');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'ai_call_slots'), 0, 'no policies on ai_call_slots');
select ok(not has_any_column_privilege('authenticated', 'public.ai_call_slots', 'select'), 'authenticated: no select');
select ok(not has_table_privilege('authenticated', 'public.ai_call_slots', 'insert'), 'authenticated: no insert');
select ok(not has_function_privilege('authenticated', 'public.ai_reserve_call(uuid, text, integer, integer, timestamptz)', 'execute'), 'authenticated may not reserve');
select ok(not has_function_privilege('anon', 'public.ai_settle_call(uuid)', 'execute'), 'anon may not settle');
select ok(not has_function_privilege('authenticated', 'public.ai_release_call(uuid)', 'execute'), 'authenticated may not release');
select ok(has_function_privilege('service_role', 'public.ai_reserve_call(uuid, text, integer, integer, timestamptz)', 'execute'), 'service_role may reserve');

-- ---------- minute limit ----------
select is((public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 2, 10, now() - interval '1 hour'))->>'ok', 'true', 'first slot');
select is((public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 2, 10, now() - interval '1 hour'))->>'pending', '1', 'second slot sees one pending');
select is(public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 2, 10, now() - interval '1 hour'),
  '{"ok": false, "reason": "minute"}'::jsonb, 'third slot within a minute is refused');
select is((select count(*)::int from public.ai_call_slots), 2, 'a refused reservation inserts nothing');
select is((public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'other_task', 2, 10, now() - interval '1 hour'))->>'ok', 'true', 'limits are per task');

-- ---------- day limit and settle ----------
update public.ai_call_slots set created_at = now() - interval '5 minutes';
select is(public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 2, 2, now() - interval '1 hour'),
  '{"ok": false, "reason": "day"}'::jsonb, 'day limit counts slots since the day start');
select is((public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 2, 2, now() - interval '1 minute'))->>'ok', 'true', 'slots before the day start do not count');

select public.ai_settle_call(id) from public.ai_call_slots where task = 'itinerary_extract';
select is((public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 9, 9, now() - interval '1 hour'))->>'pending', '0', 'settled slots hold no budget');

-- ---------- release gives the slot back; settled slots are kept ----------
select public.ai_release_call(id) from public.ai_call_slots where task = 'itinerary_extract' and settled_at is null;
select is((select count(*)::int from public.ai_call_slots where task = 'itinerary_extract'), 3, 'release removed only the pending slot');
select public.ai_release_call(id) from public.ai_call_slots where task = 'itinerary_extract';
select is((select count(*)::int from public.ai_call_slots where task = 'itinerary_extract'), 3, 'settled slots cannot be released');

-- ---------- old slots are pruned ----------
update public.ai_call_slots set created_at = now() - interval '3 days' where task = 'itinerary_extract';
select public.ai_reserve_call('5c000000-0000-4000-8000-0000000000a1', 'itinerary_extract', 9, 9, now() - interval '1 hour');
select is((select count(*)::int from public.ai_call_slots where task = 'itinerary_extract'), 1, 'slots older than 2 days are removed');

-- ---------- account deletion removes the slots ----------
delete from auth.users where id = '5c000000-0000-4000-8000-0000000000a1';
select is((select count(*)::int from public.ai_call_slots), 0, 'slots cascade with the user');

select * from finish();
rollback;
