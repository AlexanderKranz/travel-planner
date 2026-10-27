-- Reads no table, so it exposes no user data; callable with the publishable key (anon).
create or replace function public.health_check()
  returns jsonb
  language sql
  stable
  security invoker
  set search_path = ''
as $$
  select jsonb_build_object('ok', true, 'db_time', now())
$$;

revoke execute on function public.health_check() from public;
grant execute on function public.health_check() to anon, authenticated;
