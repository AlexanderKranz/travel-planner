-- Admin can disable a user: profiles.disabled_at (null = active). Set and cleared only by the server with the
-- secret key (service_role), next to the Supabase Auth ban. getUserSession() treats a set value as signed out, which
-- ends an already issued access token at once (a ban alone only stops the next refresh).
--
-- Deliberately NOT added to any column grant: users can read it (own row, existing select policy) but cannot write it.
-- No revoke/grant statements here on purpose: other migrations own the user-updatable column list, and disabled_at is
-- simply never in it.

alter table public.profiles
  add column if not exists disabled_at timestamptz;

comment on column public.profiles.disabled_at is 'Set by an admin (secret key only). Non-null = account disabled; not user-writable.';
