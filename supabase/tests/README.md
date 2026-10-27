# Database tests (pgTAP)

`rls.test.sql` checks RLS policies, column grants, the signup allowlist and the auth hook.

Docker is required, so the only place this runs today is GitHub Actions (job `db-test` in
`.github/workflows/ci.yml`). On a machine with Docker:

    supabase start
    supabase test db

The file creates the pgTAP extension itself, runs in one transaction and rolls back, so it leaves no data behind.
Test users are impersonated with `set local request.jwt.claims = '{"sub": "<uuid>", ...}'` plus
`set local role authenticated` (this is what `auth.uid()` reads). Allowlist rows must exist before users are inserted
because `private.handle_new_user` fails closed.
