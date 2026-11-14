-- pgTAP tests for provider quota slots (migration 20261121120046, city-tour spec 17.4). Run with `supabase test db`.
-- One transaction, rolled back. Slots are aged by updating their timestamps.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

-- ---------- grants and RLS: service role only ----------
select ok((select relrowsecurity from pg_class where oid = 'public.provider_slots'::regclass), 'RLS enabled on provider_slots');
select is((select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'provider_slots'), 0, 'no policies on provider_slots');
select ok(not has_any_column_privilege('authenticated', 'public.provider_slots', 'select'), 'authenticated: no select');
select ok(not has_function_privilege('authenticated', 'public.provider_reserve_slot(text, text, integer)', 'execute'), 'authenticated may not reserve');
select ok(not has_function_privilege('anon', 'public.provider_settle_slot(uuid)', 'execute'), 'anon may not settle');
select ok(has_function_privilege('service_role', 'public.provider_reserve_slot(text, text, integer)', 'execute'), 'service_role may reserve');

-- ---------- cap: every slot of the last 24 h counts (done or not); api_calls rows do not ----------
insert into public.api_calls (provider, endpoint, cache, ok) values ('transitous', 'plan', 'miss', true); -- not counted

select is((public.provider_reserve_slot('transitous', repeat('a', 64), 3))->>'ok', 'true', 'slot 1');
select is(public.provider_reserve_slot('transitous', repeat('a', 64), 3), '{"ok": false, "reason": "in_flight"}'::jsonb, 'a second live slot for the same key is refused');
select is((public.provider_reserve_slot('transitous', repeat('b', 64), 3))->>'ok', 'true', 'slot 2 for another key');
select public.provider_settle_slot((select id from public.provider_slots where cache_key = repeat('a', 64)));
select is((public.provider_reserve_slot('transitous', repeat('a', 64), 3))->>'ok', 'true', 'after settle the key is free again (slot 3)');
select is(public.provider_reserve_slot('transitous', repeat('c', 64), 3), '{"ok": false, "reason": "cap"}'::jsonb, 'cap: settled slots still count for 24 h');
update public.provider_slots set reserved_at = clock_timestamp() - interval '25 hours' where provider = 'transitous';
select is((public.provider_reserve_slot('transitous', repeat('c', 64), 3))->>'ok', 'true', 'slots older than 24 h no longer count');

-- ---------- a dead process's slot blocks its key for 2 minutes only ----------
update public.provider_slots set expires_at = clock_timestamp() - interval '1 second' where cache_key = repeat('c', 64);
select is((public.provider_reserve_slot('transitous', repeat('c', 64), 10))->>'ok', 'true', 'an expired, unsettled slot no longer blocks its key');
select ok((select expires_at > reserved_at + interval '119 seconds' from public.provider_slots where cache_key = repeat('c', 64) order by reserved_at desc limit 1), 'a new slot lives 2 minutes from its reservation');

-- ---------- other providers and cleanup ----------
select is((public.provider_reserve_slot('other_provider', repeat('a', 64), 1))->>'ok', 'true', 'caps are per provider');
update public.provider_slots set reserved_at = clock_timestamp() - interval '3 days' where provider = 'other_provider';
select public.provider_reserve_slot('other_provider', repeat('d', 64), 1);
select is((select count(*)::int from public.provider_slots where provider = 'other_provider' and cache_key = repeat('a', 64)), 0, 'slots older than 2 days are removed');

select throws_ok($$select public.provider_reserve_slot(null, repeat('a', 64), 1)$$, '22023', null, 'null provider is refused');
select throws_ok($$insert into public.provider_slots (provider, cache_key) values ('transitous', 'not-a-hash')$$, '23514', null, 'cache key must be a sha256 hex');

select * from finish();
rollback;
