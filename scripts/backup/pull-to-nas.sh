#!/bin/sh
# pull-to-nas.sh - download the newest encrypted database backup from GitHub Actions
# and keep 30 daily + 12 monthly copies. POSIX sh; runs on Synology DSM and macOS.
set -eu

CONFIG_DEFAULT="${HOME:-/root}/.config/travel-planner-backup.env"
KEEP_DAILY=30
KEEP_MONTHLY=12

usage() {
  cat <<USAGE
Usage: pull-to-nas.sh [--config FILE] [--dest DIR] [--help]

Downloads the newest "db-backup-*" artifact from GitHub Actions into DIR/daily,
copies the first backup of each month into DIR/monthly, and deletes older copies
(keeps $KEEP_DAILY daily and $KEEP_MONTHLY monthly). Already downloaded artifacts are skipped.

Config file (default: $CONFIG_DEFAULT, or env TP_BACKUP_CONFIG), KEY=VALUE lines:
  GITHUB_TOKEN=...            fine-grained token, repo access: this repo only, permission Actions: Read-only
  GITHUB_REPO=owner/name      e.g. AlexanderKranz/travel-planner
  BACKUP_DIR=/volume1/backups/travel-planner     (optional; --dest overrides)
The file must not be readable by others (chmod 600). The token is never printed.

Needs: curl, standard tools (sed, awk, sort, tr). Optional: unzip (to verify the download).
Exit code 0 = ok (including "nothing new"), non-zero = failure (message on stderr).
USAGE
}

die() { echo "pull-to-nas: ERROR: $*" >&2; exit 1; }
log() { echo "pull-to-nas: $*"; }

CONFIG="${TP_BACKUP_CONFIG:-$CONFIG_DEFAULT}"
DEST=""
while [ $# -gt 0 ]; do
  case "$1" in
    --help|-h) usage; exit 0 ;;
    --config) [ $# -ge 2 ] || die "--config needs a value"; CONFIG="$2"; shift 2 ;;
    --dest) [ $# -ge 2 ] || die "--dest needs a value"; DEST="$2"; shift 2 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

command -v curl >/dev/null 2>&1 || die "curl not found"
[ -f "$CONFIG" ] || die "config file not found: $CONFIG (see --help)"

# Refuse a config that others can read (group/other permission bits set).
perms="$(ls -ld "$CONFIG" | cut -c5-10)"
[ "$perms" = "------" ] || die "config file permissions too open ($perms). Run: chmod 600 $CONFIG"

# Read only the keys we know; do not 'source' the file.
getkey() { sed -n "s/^$1=//p" "$CONFIG" | tail -n 1 | sed 's/^"\(.*\)"$/\1/;s/^'"'"'\(.*\)'"'"'$/\1/'; }
GITHUB_TOKEN="$(getkey GITHUB_TOKEN)"
GITHUB_REPO="$(getkey GITHUB_REPO)"
[ -n "$DEST" ] || DEST="$(getkey BACKUP_DIR)"
[ -n "$GITHUB_TOKEN" ] || die "GITHUB_TOKEN missing in $CONFIG"
[ -n "$GITHUB_REPO" ] || die "GITHUB_REPO missing in $CONFIG"
[ -n "$DEST" ] || die "no target directory: set BACKUP_DIR in $CONFIG or pass --dest"
case "$GITHUB_REPO" in */*) ;; *) die "GITHUB_REPO must look like owner/name" ;; esac

mkdir -p "$DEST/daily" "$DEST/monthly" || die "cannot create $DEST"

# One run at a time (mkdir is atomic). A stale lock older than a day is ignored.
LOCK="$DEST/.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1440 2>/dev/null)" ]; then
    rmdir "$LOCK" 2>/dev/null || true
    mkdir "$LOCK" 2>/dev/null || die "another run holds the lock: $LOCK"
  else
    die "another run seems active (lock $LOCK). If not, delete that folder."
  fi
fi
TMP="$(mktemp -d "${TMPDIR:-/tmp}/tp-backup.XXXXXX")"
trap 'rm -rf "$TMP"; rmdir "$LOCK" 2>/dev/null || true' EXIT INT TERM

# curl with the token passed via stdin config, so it never shows in the process list.
api() { # $1=url $2=output file
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN" | curl -K - -sS -L --fail \
    -H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28" \
    --retry 3 --retry-delay 5 -o "$2" "$1" || return 1
}

log "listing artifacts of $GITHUB_REPO"
api "https://api.github.com/repos/$GITHUB_REPO/actions/artifacts?per_page=100" "$TMP/list.json" \
  || { [ -f "$TMP/list.json" ] && head -c 300 "$TMP/list.json" >&2; echo >&2; die "GitHub API call failed (token expired? wrong repo? token lacks Actions: read?)"; }

# Flatten the JSON and cut it into one line per artifact: "@ID,<rest>". No jq needed.
tr -d ' \n\r\t' < "$TMP/list.json" | sed 's/{"id":\([0-9][0-9]*\),"node_id"/\
@\1,"node_id"/g' | grep '^@' > "$TMP/artifacts.txt" || true

# Keep non-expired db-backup-* entries as: id name created_at
awk '
  /"expired":false/ && /"name":"db-backup-/ {
    id=$0; sub(/^@/,"",id); sub(/,.*/,"",id)
    name=$0; sub(/.*"name":"/,"",name); sub(/".*/,"",name)
    ts=$0;   sub(/.*"created_at":"/,"",ts); sub(/".*/,"",ts)
    print id, name, ts
  }' "$TMP/artifacts.txt" > "$TMP/backups.txt"

[ -s "$TMP/backups.txt" ] || die "no non-expired db-backup-* artifact found. Has backup.yml run successfully? (Actions tab)"

# Newest = highest id.
NEWEST="$(sort -n -r "$TMP/backups.txt" | head -n 1)"
ID="${NEWEST%% *}"; REST="${NEWEST#* }"
NAME="${REST%% *}"; CREATED="${REST#* }"
case "$ID" in ''|*[!0-9]*) die "could not parse artifact id from API response" ;; esac
STAMP="$(echo "$CREATED" | tr -d ':-')"      # 20261027T010203Z
MONTH="$(echo "$CREATED" | cut -c1-7)"       # 2026-10
FILE="${STAMP}__${ID}__${NAME}.zip"

# Idempotent: skip if this artifact id is already stored.
if ls "$DEST/daily" "$DEST/monthly" 2>/dev/null | grep -q "__${ID}__"; then
  log "artifact $ID ($NAME) already downloaded, nothing to do"
else
  log "downloading artifact $ID ($NAME, created $CREATED)"
  api "https://api.github.com/repos/$GITHUB_REPO/actions/artifacts/$ID/zip" "$TMP/dl.zip" \
    || die "download failed"
  [ -s "$TMP/dl.zip" ] || die "downloaded file is empty"
  if command -v unzip >/dev/null 2>&1; then
    unzip -tq "$TMP/dl.zip" >/dev/null || die "downloaded zip is corrupt"
  else
    log "note: unzip not installed, skipping integrity test"
  fi
  mv "$TMP/dl.zip" "$DEST/daily/$FILE.part" && mv "$DEST/daily/$FILE.part" "$DEST/daily/$FILE"
  log "saved $DEST/daily/$FILE"

  # First backup of a month is also kept in monthly/.
  if ! ls "$DEST/monthly" | grep -q "^${MONTH}__"; then
    cp "$DEST/daily/$FILE" "$DEST/monthly/${MONTH}__${FILE}"
    log "saved monthly copy for $MONTH"
  fi
fi

# Rotation: delete everything but the newest N (names sort chronologically).
rotate() { # $1=dir $2=keep
  ls -1 "$1" | grep '\.zip$' | sort | awk -v keep="$2" -v dir="$1" '
    { f[NR]=$0 } END { for (i=1;i<=NR-keep;i++) print dir "/" f[i] }' | while IFS= read -r old; do
      log "removing old copy: $old"; rm -f "$old"
    done
}
rotate "$DEST/daily" "$KEEP_DAILY"
rotate "$DEST/monthly" "$KEEP_MONTHLY"
log "done"
