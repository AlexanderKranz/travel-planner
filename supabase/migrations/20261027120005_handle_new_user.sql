-- On signup: create the profile, mark the allowlist entry as used, log the event.
-- Depends on profiles, signup_allowlist, app_events. The locale list ('de','en') must be
-- extended together with routing.locales in src/i18n/routing.ts.

create or replace function private.handle_new_user()
  returns trigger
  language plpgsql
  security definer
  set search_path = ''
as $$
declare
  v_locale text := new.raw_user_meta_data ->> 'locale';
begin
  -- Fail closed (B2): invite-only signup must hold even if the Before User Created hook is not
  -- enabled in the Dashboard, or if a user is created another way (Dashboard "Add user", admin API,
  -- password signup). Raising here aborts the auth.users insert.
  if new.email is null
     or not exists (
       select 1 from public.signup_allowlist
        where email operator(extensions.=) lower(new.email)::extensions.citext
     ) then
    raise exception 'signup_not_allowed' using errcode = 'P0001';
  end if;

  insert into public.profiles (id, locale, display_name)
  values (
    new.id,
    case when v_locale in ('de', 'en') then v_locale else 'de' end,
    left(coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name'), 80)
  );

  update public.signup_allowlist
     set used_at = now()
   where email operator(extensions.=) lower(new.email)::extensions.citext and used_at is null;

  insert into public.app_events (event, user_id) values ('auth.signup', new.id);

  return new;
end;
$$;

revoke execute on function private.handle_new_user() from public, anon, authenticated;
grant execute on function private.handle_new_user() to supabase_auth_admin;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();
