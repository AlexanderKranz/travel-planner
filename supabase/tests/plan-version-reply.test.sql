-- pgTAP tests for plan_versions.reply (migration 20261117120042). One transaction, rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select * from no_plan();

select has_column('public', 'plan_versions', 'reply', 'plan_versions has a reply column');
select col_is_null('public', 'plan_versions', 'reply', 'reply is optional');
select ok(has_column_privilege('authenticated', 'public.plan_versions', 'reply', 'insert'), 'authenticated may insert reply');
select ok(not has_column_privilege('authenticated', 'public.plan_versions', 'reply', 'update'), 'versions stay immutable: no update of reply');
select ok(
  (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.plan_versions'::regclass and pg_get_constraintdef(c.oid) like '%reply%') like '%2000%',
  'reply is capped at 2000 characters');

select * from finish();
rollback;
