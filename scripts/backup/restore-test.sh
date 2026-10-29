#!/bin/sh
# restore-test.sh - prove that a Travel Planner backup decrypts, restores into a throwaway Postgres
# and is complete. POSIX sh. Needs: gpg, tar, awk, psql (client major >= server major). unzip only for .zip input.
# Prints COUNTS and table/constraint NAMES only, never row content (the backup holds personal data).
set -eu

usage() {
  cat <<'USAGE'
Usage: restore-test.sh --file BACKUP --target DATABASE_URL [options]
       restore-test.sh --file BACKUP --manifest-only [--passphrase-file F]

  --file FILE          backup: the downloaded .zip, or the .tar.gz.gpg inside it
  --target URL         THROWAWAY database to restore into, with the repo's migrations already applied
                       (e.g. `supabase start`, then postgresql://postgres:postgres@127.0.0.1:54322/postgres).
                       Must be empty (no auth users) and must be on this machine: only localhost,
                       127.0.0.1, ::1 and host.docker.internal are accepted. So this script can never
                       touch the production database.
  --allow-nonlocal-target  accept any host (a scratch Supabase project). Never use with production.
  --passphrase-file F  file with the passphrase (else env BACKUP_PASSPHRASE)
  --migrations-dir D   directory of the repo's migrations to compare with (default: supabase/migrations
                       relative to the current directory)
  --require-rows LIST  comma list of tables that must have at least 1 restored row
                       (default: auth.users,public.profiles,public.trips)
  --summary-file F     append a Markdown summary to F (in GitHub Actions: $GITHUB_STEP_SUMMARY)
  --manifest-only      only decrypt and print MANIFEST.txt, touch no database
  --help

Checks (each prints PASS or FAIL, exit code 1 if any FAIL):
  1. decrypt + unpack, restore via restore.sh (one transaction, migration version must match MANIFEST)
  2. target migrations equal the migrations directory (latest version and count)
  3. per table: restored row count equals the rows in the backup file (completeness)
  4. required tables have at least 1 row
  5. Row-Level Security is enabled on every table in schema public
  6. foreign keys of public and auth have no orphan rows
USAGE
}

FILE=""; TARGET=""; PPFILE=""; MIGDIR="supabase/migrations"; REQ="auth.users,public.profiles,public.trips"
SUMFILE=""; MANONLY=0; NONLOCAL=0
die() { echo "restore-test: ERROR: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --file) [ $# -ge 2 ] || die "--file needs a value"; FILE="$2"; shift 2 ;;
    --target) [ $# -ge 2 ] || die "--target needs a value"; TARGET="$2"; shift 2 ;;
    --passphrase-file) [ $# -ge 2 ] || die "--passphrase-file needs a value"; PPFILE="$2"; shift 2 ;;
    --migrations-dir) [ $# -ge 2 ] || die "--migrations-dir needs a value"; MIGDIR="$2"; shift 2 ;;
    --require-rows) [ $# -ge 2 ] || die "--require-rows needs a value"; REQ="$2"; shift 2 ;;
    --summary-file) [ $# -ge 2 ] || die "--summary-file needs a value"; SUMFILE="$2"; shift 2 ;;
    --manifest-only) MANONLY=1; shift ;;
    --allow-nonlocal-target) NONLOCAL=1; shift ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$FILE" ] || { usage >&2; die "--file is required"; }
[ -f "$FILE" ] || die "file not found: $FILE"
if [ "$MANONLY" -eq 0 ]; then
  [ -n "$TARGET" ] || { usage >&2; die "--target is required"; }
  case "$TARGET" in postgres://*|postgresql://*) ;; *) die "--target must start with postgresql://" ;; esac
  [ -d "$MIGDIR" ] || die "migrations directory not found: $MIGDIR (run from the repo root or pass --migrations-dir)"
  NEED="gpg tar awk psql"
else
  NEED="gpg tar"
fi
for c in $NEED; do command -v "$c" >/dev/null 2>&1 || die "$c not found (macOS: brew install gnupg libpq)"; done

HERE="$(cd "$(dirname "$0")" && pwd)"
HOST=""
if [ "$MANONLY" -eq 0 ]; then
  HOST="$(printf '%s' "$TARGET" | sed 's#^[a-z]*://##; s#[/?].*$##; s#^.*@##; s#^\[\(.*\)\]#\1#; s#:[0-9]*$##')"
  if [ "$NONLOCAL" -eq 0 ]; then
    case "$HOST" in
      localhost|127.0.0.1|::1|host.docker.internal) ;;
      *) die "target host '$HOST' is not local. This test only restores into a throwaway database on this machine (see --help)." ;;
    esac
  fi
fi

umask 077
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tp-rtest.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT INT TERM
: > "$TMP/summary.md"
FAILS=0
md() { printf '%s\n' "$*" >> "$TMP/summary.md"; }
pass() { echo "PASS  $*"; md "- PASS: $*"; }
fail() { echo "FAIL  $*"; md "- FAIL: $*"; FAILS=$((FAILS + 1)); }
finish() {
  if [ "$FAILS" -eq 0 ]; then md ""; md "**Result: PASS**"; echo "RESULT: PASS"
  else md ""; md "**Result: FAIL ($FAILS check(s) failed)**"; echo "RESULT: FAIL ($FAILS check(s) failed)"; fi
  [ -z "$SUMFILE" ] || cat "$TMP/summary.md" >> "$SUMFILE"
  [ "$FAILS" -eq 0 ] || exit 1
  exit 0
}
fatal() { fail "$*"; finish; }
# Query the target; only ever used for counts and names.
q() { psql "$TARGET" -X -Atq -v ON_ERROR_STOP=1 -c "$1" < /dev/null; }

# ---- 1. decrypt + unpack ----
case "$FILE" in
  *.zip)
    command -v unzip >/dev/null 2>&1 || die "unzip not found; unzip the file yourself and pass the .gpg"
    unzip -q -o "$FILE" -d "$TMP/zip" || die "cannot unzip $FILE"
    GPGFILE="$(ls "$TMP"/zip/*.gpg 2>/dev/null | head -n 1)"
    [ -n "$GPGFILE" ] || die "no .gpg file inside the zip" ;;
  *) GPGFILE="$FILE" ;;
esac

# Passphrase: a trailing newline in the stored secret must not matter (backup.yml strips it too).
if [ -n "$PPFILE" ]; then
  [ -f "$PPFILE" ] || die "passphrase file not found"
  tr -d '\r\n' < "$PPFILE" > "$TMP/pp"
elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  printf '%s' "$BACKUP_PASSPHRASE" | tr -d '\r\n' > "$TMP/pp"
else
  die "no passphrase: pass --passphrase-file or set BACKUP_PASSPHRASE"
fi

echo "Decrypting..."
if ! gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$TMP/pp" -d -o "$TMP/backup.tar.gz" "$GPGFILE" 2>/dev/null; then
  if [ "$MANONLY" -eq 1 ]; then die "decryption failed (wrong passphrase or damaged file)"; fi
  fatal "decryption failed (wrong passphrase or damaged file)"
fi
mkdir "$TMP/x"
if ! tar -C "$TMP/x" -xzf "$TMP/backup.tar.gz" 2>/dev/null; then
  if [ "$MANONLY" -eq 1 ]; then die "cannot unpack backup"; fi
  fatal "cannot unpack backup (not a tar.gz after decryption)"
fi
if [ ! -s "$TMP/x/MANIFEST.txt" ]; then
  if [ "$MANONLY" -eq 1 ]; then die "backup incomplete (MANIFEST.txt missing)"; fi
  fatal "backup incomplete (MANIFEST.txt missing)"
fi
if [ "$MANONLY" -eq 1 ]; then cat "$TMP/x/MANIFEST.txt"; exit 0; fi
if [ ! -s "$TMP/x/data.sql" ]; then fatal "backup incomplete (data.sql missing)"; fi
pass "backup decrypted and unpacked"
md ""; md '```'; cat "$TMP/x/MANIFEST.txt" >> "$TMP/summary.md"; md '```'; md ""

# ---- 2. target must be reachable and empty ----
q 'select 1' > /dev/null 2>&1 || fatal "cannot connect to the target database (is it running? supabase start)"
have_users="$(q 'select count(*) from auth.users' 2>/dev/null)" || fatal "target has no auth.users (migrations/Supabase not set up)"
have_prof="$(q 'select count(*) from public.profiles' 2>/dev/null)" || fatal "target has no public.profiles (migrations not applied)"
if [ "$have_users" != "0" ] || [ "$have_prof" != "0" ]; then
  fatal "target is not empty ($have_users auth users, $have_prof profiles). Use a fresh database so the counts prove the restore."
fi
pass "target is local and empty"

# Expected row count per table, straight from the COPY blocks of the backup (counts only).
awk '/^COPY /{name=$2; n=0; inb=1; next} inb && /^\\\.$/{print name, n; inb=0; next} inb{n++}' \
  "$TMP/x/data.sql" > "$TMP/expected.txt"
[ -s "$TMP/expected.txt" ] || fatal "data.sql contains no COPY blocks (empty dump?)"

# ---- 3. restore with the real restore.sh ----
# restore.sh asks to type the target host; we feed it. --prod-host is a dummy: the local-host rule above is the guard.
# Output is filtered: psql errors can quote row values in DETAIL/CONTEXT, so only safe lines are shown.
show_log() {
  grep -E '^(Decrypting|created_utc=|git_commit=|migration_version=|pg_dump=|server_major=|data_schemas=|Target host|Backup file|Restoring|Restore finished|restore: ERROR: (migration mismatch|decryption failed|backup incomplete|cannot))' "$TMP/restore.log" | sed 's/^/    /' || true
  grep -E '^(psql: )?(ERROR|FATAL):' "$TMP/restore.log" | sed -E 's/^((psql: )?(ERROR|FATAL):[^:]*).*/    \1 (details hidden)/' | head -n 5 || true
}
RESTORE_OK=1
printf '%s\n' "$HOST" | sh "$HERE/restore.sh" --file "$GPGFILE" --target "$TARGET" --prod-host "__restore_test_no_prod_host__" \
  --passphrase-file "$TMP/pp" > "$TMP/restore.log" 2>&1 || RESTORE_OK=0
show_log
[ "$RESTORE_OK" -eq 1 ] || fatal "restore.sh failed (see filtered output above; the transaction was rolled back)"
pass "restore.sh loaded the data in one transaction"

# ---- 4. migrations ----
REPO_LATEST="$(ls "$MIGDIR" | sed -n 's/^\([0-9][0-9]*\)_.*\.sql$/\1/p' | sort | tail -n 1)"
REPO_N="$(ls "$MIGDIR" | grep -c '^[0-9][0-9]*_.*\.sql$' || true)"
HAVE_LATEST="$(q "select coalesce(max(version),'') from supabase_migrations.schema_migrations" 2>/dev/null)" || HAVE_LATEST=""
HAVE_N="$(q "select count(*) from supabase_migrations.schema_migrations" 2>/dev/null)" || HAVE_N=""
if [ -n "$REPO_LATEST" ] && [ "$HAVE_LATEST" = "$REPO_LATEST" ] && [ "$HAVE_N" = "$REPO_N" ]; then
  pass "migrations: target is at $HAVE_LATEST ($HAVE_N migrations), equal to the repo"
else
  fail "migrations differ: repo latest '$REPO_LATEST' ($REPO_N files), target '$HAVE_LATEST' ($HAVE_N applied)"
fi

# ---- 5. completeness: restored count == rows in the backup file ----
md ""; md "| table | rows in backup | rows restored | match |"; md "|---|---:|---:|---|"
TOTAL=0; BAD=0
while read -r name want; do
  case "$name" in
    *[!a-z0-9_.]*|.*|*.|"") fail "unexpected table name format in backup (not shown)"; BAD=$((BAD + 1)); continue ;;
    *.*) ;;
    *) fail "unexpected table name format in backup (not shown)"; BAD=$((BAD + 1)); continue ;;
  esac
  got="$(q "select count(*) from $name" 2>/dev/null)" || got="error"
  TOTAL=$((TOTAL + 1))
  if [ "$got" = "$want" ]; then ok="yes"; else ok="NO"; BAD=$((BAD + 1)); fi
  echo "    $name: backup=$want restored=$got $ok"
  md "| $name | $want | $got | $ok |"
done < "$TMP/expected.txt"
md ""
if [ "$BAD" -eq 0 ]; then pass "row counts: all $TOTAL tables restored completely"
else fail "row counts: $BAD of $TOTAL tables differ from the backup"; fi

# ---- 6. key tables are not empty ----
for t in $(printf '%s' "$REQ" | tr ',' ' '); do
  case "$t" in *[!a-z0-9_.]*|"") fail "invalid table name in --require-rows"; continue ;; esac
  n="$(q "select count(*) from $t" 2>/dev/null)" || n="error"
  case "$n" in
    ''|*[!0-9]*) fail "required table $t is missing or unreadable" ;;
    0) fail "required table $t has 0 rows" ;;
    *) pass "$t has $n rows" ;;
  esac
done

# ---- 7. RLS ----
NORLS="$(q "select string_agg(c.relname, ', ' order by c.relname) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p') and not c.relrowsecurity" 2>/dev/null)" || NORLS="error"
NTAB="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r','p')" 2>/dev/null)" || NTAB="?"
if [ -z "$NORLS" ]; then pass "RLS enabled on all $NTAB tables in public"
else fail "RLS is NOT enabled on: $NORLS"; fi

# ---- 8. foreign key orphans ----
psql "$TARGET" -X -Atq -v ON_ERROR_STOP=1 -f - > "$TMP/fk.txt" 2> "$TMP/fk.err" <<'SQL' || true
create function pg_temp.fk_orphans() returns table (o_table text, o_fk text, o_orphans bigint)
language plpgsql as $f$
declare r record; cond_nn text; cond_join text; n bigint;
begin
  for r in
    select c.conname, c.conrelid, c.confrelid, c.conkey, c.confkey,
           c.conrelid::regclass::text as child, c.confrelid::regclass::text as parent
    from pg_constraint c join pg_namespace ns on ns.oid = c.connamespace
    where c.contype = 'f' and ns.nspname in ('public', 'auth')
    order by 1
  loop
    select string_agg(format('c.%I is not null', a.attname), ' and '),
           string_agg(format('p.%I = c.%I', pa.attname, a.attname), ' and ')
      into cond_nn, cond_join
    from unnest(r.conkey, r.confkey) as k(ck, pk)
    join pg_attribute a  on a.attrelid  = r.conrelid  and a.attnum  = k.ck
    join pg_attribute pa on pa.attrelid = r.confrelid and pa.attnum = k.pk;
    execute format('select count(*) from %s c where %s and not exists (select 1 from %s p where %s)',
                   r.child, cond_nn, r.parent, cond_join) into n;
    o_table := r.child; o_fk := r.conname; o_orphans := n;
    return next;
  end loop;
end $f$;
select o_table || '|' || o_fk || '|' || o_orphans from pg_temp.fk_orphans();
SQL
if [ ! -s "$TMP/fk.txt" ]; then
  fail "foreign key check could not run (no result)"
  # psql's own error text is safe here: the function only runs counts. Show the first line only.
  head -n 1 "$TMP/fk.err" | cut -c1-200 | sed 's/^/    /' || true
else
  FKN="$(wc -l < "$TMP/fk.txt" | tr -d ' ')"
  FKBAD="$(grep -vc '|0$' "$TMP/fk.txt" || true)"
  if [ "$FKBAD" = "0" ]; then pass "foreign keys: $FKN constraints checked, no orphan rows"
  else
    fail "foreign keys: orphan rows found in $FKBAD of $FKN constraints (FK violation)"
    grep -v '|0$' "$TMP/fk.txt" | while IFS='|' read -r t k c; do echo "    $t / $k: $c orphan rows"; md "  - $t / $k: $c orphan rows"; done
  fi
fi

finish
