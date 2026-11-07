# Database tests (pgTAP)

`rls.test.sql` checks RLS policies, column grants, the signup allowlist and the auth hook. `feedback.test.sql` checks the feedback table, its limit functions and the screenshot bucket.

`sharing.test.sql` checks sharing trips and purposes (share tables, helper functions, widened policies, owner-only columns, `share_resource`, disabled owners, cascades; `docs/specs/sharing.md`).
`group-sharing.test.sql` checks sharing travel groups (group_shares, helpers, widened policies, the entry guard, "That's me" claims, link pruning, group references on trips and searches, `share_contacts`, admin counters; `docs/specs/group-sharing.md`).
`sharing-concurrency.sh` is not pgTAP: it needs two real connections, so it runs two `psql` sessions against the local database and checks that the 10-grantee cap holds under concurrency (trips and groups) and that two parallel claims of an entry, or two claims by one user, end with exactly one link (`bash supabase/tests/sharing-concurrency.sh` after `supabase start`; needs `psql`; `DATABASE_URL` overrides the default local connection). `supabase test db` does not run it.

Docker is required, so the only place this runs today is GitHub Actions (job `db-test` in
`.github/workflows/ci.yml`). On a machine with Docker:

    supabase start
    supabase test db

The file creates the pgTAP extension itself, runs in one transaction and rolls back, so it leaves no data behind.
Test users are impersonated with `set local request.jwt.claims = '{"sub": "<uuid>", ...}'` plus
`set local role authenticated` (this is what `auth.uid()` reads). Allowlist rows must exist before users are inserted
because `private.handle_new_user` fails closed.
