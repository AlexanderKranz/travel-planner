#!/bin/sh
# restore.sh - decrypt a Travel Planner backup and restore it into a database you name.
# POSIX sh. Needs: gpg, tar, psql (client major version >= server major). unzip only for .zip input.
set -eu

usage() {
  cat <<'USAGE'
Usage: restore.sh --file BACKUP --target DATABASE_URL --prod-host PROD_HOST_OR_REF [options]

  --file FILE         backup: the downloaded .zip from GitHub/NAS, or the .tar.gz.gpg inside it
  --target URL        database to restore INTO (postgresql://...). Must be a fresh Supabase project
                      where `supabase db push` already applied the migrations of the backup's commit.
  --prod-host STR     production DB host or project ref. The script refuses if STR appears
                      anywhere in --target (covers pooler hosts, where the project ref is in the user name).
  --allow-prod        allow restoring into production (disaster recovery). Still asks to confirm.
  --skip-version-check  do not require the target's migration version to match the backup
                      (e.g. old backups without migration_version).
  --passphrase-file F read the passphrase from file F (else env BACKUP_PASSPHRASE, else gpg asks you)
  --help

What happens: decrypt -> unpack (MANIFEST.txt, data.sql; schema.sql is reference only) ->
check that the target's latest migration version equals MANIFEST migration_version ->
psql in ONE transaction: data.sql (public + auth data) with triggers off
(session_replication_role = replica). If anything fails, nothing is changed.
Then you must type the target host to confirm.
USAGE
}
die() { echo "restore: ERROR: $*" >&2; exit 1; }

FILE=""; TARGET=""; PROD=""; KNOW=0; SKIPV=0; PPFILE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --file) [ $# -ge 2 ] || die "--file needs a value"; FILE="$2"; shift 2 ;;
    --target) [ $# -ge 2 ] || die "--target needs a value"; TARGET="$2"; shift 2 ;;
    --prod-host) [ $# -ge 2 ] || die "--prod-host needs a value"; PROD="$2"; shift 2 ;;
    --passphrase-file) [ $# -ge 2 ] || die "--passphrase-file needs a value"; PPFILE="$2"; shift 2 ;;
    --allow-prod) KNOW=1; shift ;;
    --skip-version-check) SKIPV=1; shift ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

[ -n "$FILE" ] || { usage >&2; die "--file is required"; }
[ -n "$TARGET" ] || { usage >&2; die "--target is required"; }
[ -n "$PROD" ] || { usage >&2; die "--prod-host is required (safety check against restoring into production)"; }
[ -f "$FILE" ] || die "file not found: $FILE"
case "$TARGET" in postgres://*|postgresql://*) ;; *) die "--target must start with postgresql://" ;; esac
for c in gpg tar psql; do command -v "$c" >/dev/null 2>&1 || die "$c not found (macOS: brew install gnupg libpq)"; done

# Host = between the last '@' of the authority and the next ':' '/' or '?'.
HOST="$(printf '%s' "$TARGET" | sed 's#^[a-z]*://##; s#[/?].*$##; s#^.*@##; s#:.*$##')"
[ -n "$HOST" ] || die "cannot read host from --target"

case "$TARGET" in
  *"$PROD"*)
    [ "$KNOW" -eq 1 ] || die "target looks like PRODUCTION ('$PROD' found in --target). Refusing. Use a scratch database, or --allow-prod for a real disaster recovery."
    echo "WARNING: restoring into PRODUCTION because of --allow-prod" >&2 ;;
esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/tp-restore.XXXXXX")"
chmod 700 "$TMP"
trap 'rm -rf "$TMP"' EXIT INT TERM

case "$FILE" in
  *.zip)
    command -v unzip >/dev/null 2>&1 || die "unzip not found; unzip the file yourself and pass the .gpg"
    unzip -q -o "$FILE" -d "$TMP/zip" || die "cannot unzip $FILE"
    GPGFILE="$(ls "$TMP"/zip/*.gpg 2>/dev/null | head -n 1)"
    [ -n "$GPGFILE" ] || die "no .gpg file inside the zip" ;;
  *) GPGFILE="$FILE" ;;
esac

echo "Decrypting..."
if [ -n "$PPFILE" ]; then
  [ -f "$PPFILE" ] || die "passphrase file not found"
  gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$PPFILE" -d -o "$TMP/backup.tar.gz" "$GPGFILE" || die "decryption failed (wrong passphrase?)"
elif [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  printf '%s' "$BACKUP_PASSPHRASE" | gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 0 -d -o "$TMP/backup.tar.gz" "$GPGFILE" || die "decryption failed (wrong passphrase?)"
else
  gpg --quiet -d -o "$TMP/backup.tar.gz" "$GPGFILE" || die "decryption failed (wrong passphrase?)"
fi
mkdir "$TMP/x"
tar -C "$TMP/x" -xzf "$TMP/backup.tar.gz" || die "cannot unpack backup"
[ -s "$TMP/x/data.sql" ] || die "backup incomplete (data.sql missing)"
[ -s "$TMP/x/MANIFEST.txt" ] || die "backup incomplete (MANIFEST.txt missing)"
cat "$TMP/x/MANIFEST.txt"

WANT_MIG="$(sed -n 's/^migration_version=//p' "$TMP/x/MANIFEST.txt" | head -n 1)"
WANT_SHA="$(sed -n 's/^git_commit=//p' "$TMP/x/MANIFEST.txt" | head -n 1)"
HAVE_MIG="$(psql "$TARGET" -Atq --variable ON_ERROR_STOP=1 \
  -c "select coalesce(max(version),'') from supabase_migrations.schema_migrations" 2>/dev/null)" \
  || HAVE_MIG=""
if [ -z "$WANT_MIG" ] || [ "$HAVE_MIG" != "$WANT_MIG" ]; then
  msg="migration mismatch: backup expects version '${WANT_MIG:-unknown}', target has '${HAVE_MIG:-none}'. In the repo run: git checkout ${WANT_SHA:-<commit from MANIFEST>} && supabase link --project-ref <TARGET_REF> && supabase db push"
  if [ "$SKIPV" -eq 1 ]; then echo "WARNING: $msg (continuing because of --skip-version-check)" >&2
  else die "$msg"; fi
fi

echo "Target host : $HOST"
echo "Backup file : $FILE"
echo "This will write the backup's DATA (public + auth) into that database (migrations must already be applied)."
printf 'Type the target host to confirm: '
read -r answer
[ "$answer" = "$HOST" ] || die "confirmation did not match; aborted, nothing changed"

echo "Restoring (single transaction)..."
psql "$TARGET" --single-transaction --variable ON_ERROR_STOP=1 --quiet \
  --command 'SET session_replication_role = replica' \
  --file "$TMP/x/data.sql" \
  || die "restore failed; the transaction was rolled back, target is unchanged"
echo "Restore finished. Compare row counts with production (docs/runbook.md, restore test)."
