-- pgTAP tests for provider quota slots (migration 20261121120046, city-tour spec 17.4). Run with `supabase test db`.
-- One transaction, rolled back. now() is constant inside it, so slots and calls are aged by updating timestamps.
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

-- ---------- cap: network calls of the last 24 h plus live slots ----------
insert into public.api_calls (provider, endpoint, cache, ok) values
  ('transitous', 'plan', 'miss', true),
  ('transitous', 'plan', 'hit', true),                                   -- a cache hit is no network call
  ('transitous', 'plan', 'miss', false);
insert into public.api_calls (provider, endpoint, cache, ok, error_code) values ('transitous', 'plan', 'bypass', false, 'quota_guard');
insert into public.api_calls (provider, endpoint, cache, ok, created_at) values ('transitous', 'plan', 'miss', true, now() - interval '25 hours');
insert into public.api_calls (provider, endpoint, cache, ok) values ('openrouteservice', 'tour_route', 'miss', true);
-- counted: 2 (two misses within 24 h)

select is((public.provider_reserve_slot('transitous', repeat('a', 64), 4))->>'ok', 'true', 'slot 1 under the cap (2 calls + 0 live < 4)');
select is(public.provider_reserve_slot('transitous', repeat('a', 64), 4), '{"ok": false, "reason": "in_flight"}'::jsonb, 'a second live slot for the same key is refused');
select is((public.provider_reserve_slot('transitous', repeat('b', 64), 4))->>'ok', 'true', 'slot 2 for another key (2 calls + 1 live < 4)');
select is(public.provider_reserve_slot('transitous', repeat('c', 64), 4), '{"ok": false, "reason": "cap"}'::jsonb, 'cap reached (2 calls + 2 live)');

-- ---------- done and expired slots stop counting ----------
select public.provider_settle_slot((select id from public.provider_slots where cache_key = repeat('a', 64)));
select is((public.provider_reserve_slot('transitous', repeat('a', 64), 4))->>'ok', 'true', 'after settle: same key may reserve again (2 calls + 1 live)');
select is(public.provider_reserve_slot('transitous', repeat('c', 64), 4), '{"ok": false, "reason": "cap"}'::jsonb, 'cap again: 2 calls + 2 live (b and the new a)');
update public.provider_slots set expires_at = now() - interval '1 second' where cache_key = repeat('b', 64);
select is((public.provider_reserve_slot('transitous', repeat('c', 64), 4))->>'ok', 'true', 'an expired slot no longer counts');

-- ---------- other providers and cleanup ----------
select is((public.provider_reserve_slot('other_provider', repeat('a', 64), 1))->>'ok', 'true', 'caps are per provider');
update public.provider_slots set reserved_at = now() - interval '3 days' where provider = 'other_provider';
select public.provider_reserve_slot('other_provider', repeat('d', 64), 1);
select is((select count(*)::int from public.provider_slots where provider = 'other_provider' and cache_key = repeat('a', 64)), 0, 'slots older than 2 days are removed');

select throws_ok($$select public.provider_reserve_slot(null, repeat('a', 64), 1)$$, '22023', null, 'null provider is refused');
select throws_ok($$insert into public.provider_slots (provider, cache_key) values ('transitous', 'not-a-hash')$$, '23514', null, 'cache key must be a sha256 hex');

select * from finish();
rollback;
