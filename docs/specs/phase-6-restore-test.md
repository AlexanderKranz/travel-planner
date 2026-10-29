# Phase 6 spec: first restore test

Status: implemented on branch `phase-6/restore-test`. Backlog item: "Backup restore test proves backups decrypt and restore". Operations: `docs/runbook.md`, section 5 ("Restore test").

## 1. What exists

| Piece | Where |
|---|---|
| Workflow (jobs `dry-run` and `restore-test`) | `.github/workflows/restore-test.yml` |
| Shared test logic | `scripts/backup/restore-test.sh` (uses the existing `restore.sh` for the load) |
| Fake backup builder for the dry run | `scripts/backup/synthetic-backup.sh`, `scripts/backup/fixtures/restore-test-seed.sql` |

## 2. Decisions

- **[D1] Restore into a local Supabase on the runner.** Same `supabase start` as the `db-test` job in `ci.yml` (same CLI version, same service exclusions), because it applies the repo's migrations and gives the real `auth` schema, extensions and the `supabase_migrations` table that `restore.sh` checks. A plain Postgres container would need all of that rebuilt by hand. Postgres major 17 (`config.toml`), matching `backup.yml`; the runner installs `postgresql-client-17` so `psql`/`pg_dump` are not older than the server.
- **[D2] Schema comes from the backup's commit.** The real job reads `git_commit` from the MANIFEST, checks that commit out as a git worktree and starts Supabase there, exactly like a real restore (runbook section 5, step 4). Reason: production may lag behind `main` (migrations not yet deployed). The summary shows how many newer migrations exist in the repo. The check "migrations match" compares the restored database with that commit's migrations directory (latest version and count).
- **[D3] Monthly schedule is OFF.** `workflow_dispatch` is the trigger; the `schedule` block is present but commented out. A schedule would decrypt production backups unattended and, as the repository is idle, GitHub disables scheduled workflows after 60 days anyway. Alex decides.
- **[D4] Backup source = the newest non-expired `db-backup-*` artifact** of this repository, listed and downloaded through the GitHub API with the job's own `GITHUB_TOKEN` (permission `actions: read`; nothing else beyond `contents: read`). Optional input `artifact_name` picks a specific one. Artifacts expire after 30 days, so the test covers the 30-day window, not the NAS copies.
- **[D5] Same secret as encryption: `BACKUP_PASSPHRASE`.** Referenced by name only. `SUPABASE_DB_URL` is not available to this workflow, so production cannot be reached even by mistake. As a second guard `restore-test.sh` accepts only targets on localhost / 127.0.0.1 / ::1 / host.docker.internal (override flag exists for a scratch Supabase project, documented as "never production").
- **[D6] No personal data in logs or artifacts.** The script prints only counts and table / constraint names. `restore.sh` output is filtered: psql errors can quote row values in `DETAIL`/`CONTEXT`, so after a failure only the error class is shown ("details hidden"). Docker/database logs are not printed in the production job. Nothing is uploaded as artifact; decrypted files live in a `chmod 700` temp dir that is removed on exit, on an ephemeral runner.
- **[D7] Completeness is measured against the backup file, not against production.** Expected rows per table are counted from the `COPY` blocks in `data.sql` and compared with `count(*)` after the restore. This catches truncated or partially failing restores without touching production. Production-vs-restore comparison stays a manual step in the disaster runbook.
- **[D8] Checks.** Decrypt and unpack; target empty before (so counts prove the restore); `restore.sh` succeeds (it enforces migration version equals MANIFEST); target migrations equal the migrations directory; per-table row counts equal; `auth.users`, `public.profiles`, `public.trips` have rows (`--require-rows` changes the list); RLS enabled on every table in `public`; no orphan rows in any foreign key of `public` and `auth` (generic query over `pg_constraint`, composite keys and `MATCH SIMPLE` null handling included; needed because `restore.sh` loads with triggers off, which also switches FK checks off).
- **[D9] Dry run with synthetic data in the same workflow, not in `ci.yml`.** Triggers: push to `phase-*/**` and pull requests that touch `scripts/backup/**`, `supabase/migrations/**` or the workflow file, plus manual runs. It seeds a tiny fake fixture (`example.invalid` users, group, trips, plan, item), dumps with the same options as `backup.yml`, encrypts with a throwaway key made in the job, empties the database and runs the same `restore-test.sh`. It also proves the test can fail: a wrong passphrase must be rejected, and a backup containing an orphan trip must fail with "FK violation".
- **[D10] "Last tested" is a manual line** in the runbook. A workflow cannot commit to `main` without a token with write rights, which is not worth it for one date.

## 3. Verification

The scripts cannot run on the author's machine without Docker, so the proof is the GitHub Actions run of the `dry-run` job on this branch (see the report). The production job (`restore-test`) was not run by the author (it reads production backups; Alex starts it).

## 4. Needs Alex

1. **Run it once:** Actions -> Restore test -> Run workflow (branch `main` after merge, or this branch before) and read the Summary. Then update the "Last tested" line in the runbook.
2. **Confirm the secret `BACKUP_PASSPHRASE` exists** (it must already, `backup.yml` needs it) and equals the passphrase in your password manager.
3. **Confirm at least one non-expired `db-backup-*` artifact exists** (Actions -> Nightly database backup). If the run says none, start the backup by hand first.
4. **Decide about the monthly schedule** (D3). Default: off.
5. Keep "Settings -> Actions -> General -> Workflow permissions" as is; the workflow requests `actions: read` itself.
