#!/bin/sh
# synthetic-backup.sh - build a FAKE encrypted backup from a LOCAL Supabase, for the restore-test dry run.
# It seeds a tiny fixture, dumps it exactly like .github/workflows/backup.yml, encrypts it, and then
# empties the local database again so restore-test.sh has an empty target.
# POSIX sh. Needs: psql, pg_dump (major >= server), gpg, tar. Refuses non-local databases (it deletes data).
set -eu

usage() {
  cat <<'USAGE'
Usage: synthetic-backup.sh --source URL --out FILE --passphrase-file F [--break-fk] [--no-wipe]
       synthetic-backup.sh --source URL --wipe-only

  --source URL         LOCAL database (localhost / 127.0.0.1) with the migrations applied and empty
  --out FILE           encrypted result (.tar.gz.gpg)
  --passphrase-file F  file with a throwaway passphrase
  --break-fk           also insert an orphan row (trip with a non-existing owner) to prove that
                       restore-test.sh detects broken foreign keys
  --no-wipe            keep the seeded data in the source database
  --wipe-only          only empty the source database (public tables and auth.users)
  --help
USAGE
}
die() { echo "synthetic-backup: ERROR: $*" >&2; exit 1; }

SRC=""; OUT=""; PPFILE=""; BREAK=0; WIPE=1; WIPEONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --source) [ $# -ge 2 ] || die "--source needs a value"; SRC="$2"; shift 2 ;;
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT="$2"; shift 2 ;;
    --passphrase-file) [ $# -ge 2 ] || die "--passphrase-file needs a value"; PPFILE="$2"; shift 2 ;;
    --break-fk) BREAK=1; shift ;;
    --no-wipe) WIPE=0; shift ;;
    --wipe-only) WIPEONLY=1; shift ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done
[ -n "$SRC" ] || { usage >&2; die "--source is required"; }
case "$SRC" in postgres://*|postgresql://*) ;; *) die "--source must start with postgresql://" ;; esac
HOST="$(printf '%s' "$SRC" | sed 's#^[a-z]*://##; s#[/?].*$##; s#^.*@##; s#^\[\(.*\)\]#\1#; s#:[0-9]*$##')"
case "$HOST" in
  localhost|127.0.0.1|::1|host.docker.internal) ;;
  *) die "source host '$HOST' is not local. This script deletes data and must never run against a real database." ;;
esac
HERE="$(cd "$(dirname "$0")" && pwd)"
command -v psql >/dev/null 2>&1 || die "psql not found"

sql() { psql "$SRC" -X -v ON_ERROR_STOP=1 -q "$@" < /dev/null; }

wipe() {
  sql -c "do \$\$ declare t text; begin
            for t in select format('%I.%I', schemaname, tablename) from pg_tables where schemaname = 'public' loop
              execute 'truncate table ' || t || ' cascade';
            end loop; end \$\$" -c "delete from auth.users"
  echo "source database emptied"
}

if [ "$WIPEONLY" -eq 1 ]; then wipe; exit 0; fi

[ -n "$OUT" ] || { usage >&2; die "--out is required"; }
[ -f "$PPFILE" ] || die "--passphrase-file is required and must exist"
for c in pg_dump gpg tar; do command -v "$c" >/dev/null 2>&1 || die "$c not found"; done
[ "$(sql -Atc 'select count(*) from auth.users')" = "0" ] || die "source is not empty; run with --wipe-only first"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tp-synth.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM

sql --single-transaction -f "$HERE/fixtures/restore-test-seed.sql"
if [ "$BREAK" -eq 1 ]; then
  # Triggers off (replica) so the foreign key is not enforced: this simulates a damaged backup.
  sql --single-transaction -c "set local session_replication_role = replica" \
    -c "insert into public.trips (owner_id, dest_kind, dest_name, length_days) values ('deadbeef-1111-4000-8000-00000000dead', 'freetext', 'Orphan', 2)"
fi
echo "fixture seeded"

mig="$(sql -Atc "select coalesce(max(version),'') from supabase_migrations.schema_migrations")"
# Same dump options as backup.yml.
pg_dump "$SRC" --data-only --no-owner -n public -n auth --exclude-table-data='auth.schema_migrations' -f "$TMP/data.sql"
pg_dump "$SRC" --schema-only --no-owner -n public -n private -n extensions -n auth -f "$TMP/schema.sql"
{
  echo "created_utc=$(date -u +%Y%m%dT%H%M%SZ)"
  echo "git_commit=${GITHUB_SHA:-synthetic}"
  echo "migration_version=$mig"
  echo "pg_dump=$(pg_dump --version)"
  echo "data_schemas=public,auth"
  echo "synthetic=true"
} > "$TMP/MANIFEST.txt"
tar -C "$TMP" -czf "$TMP/backup.tar.gz" MANIFEST.txt schema.sql data.sql
tr -d '\r\n' < "$PPFILE" | gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-fd 0 \
  --symmetric --cipher-algo AES256 -o "$OUT" "$TMP/backup.tar.gz"
echo "synthetic backup written: $OUT ($(wc -c < "$OUT" | tr -d ' ') bytes)"

if [ "$WIPE" -eq 1 ]; then wipe; fi
