#!/usr/bin/env bash
# Concurrency test for public.share_resource (docs/specs/sharing.md section 5, decision D25).
# Two psql sessions share the same trip with two different NEW grantees while the trip already has 9 grantees. The
# first session holds its transaction open; the second one must wait on the row lock of step 3 and, after the first
# commits, answer limit_reached. Afterwards the trip has exactly 10 share rows.
#
# Needs psql and a local database with the migrations applied (`supabase start`). It cannot run inside pgTAP, because
# pgTAP runs in one transaction on one connection. Not run by `supabase test db`; run it after that:
#
#   supabase start
#   supabase test db
#   bash supabase/tests/sharing-concurrency.sh
#
# DATABASE_URL overrides the default local Supabase connection. The script commits real rows (two sessions cannot
# share a transaction), so it creates users and a trip with the marker domain @concurrency.test and removes them again
# on exit, also after a failure.
set -euo pipefail

DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
PSQL=(psql "$DB_URL" -X -q -t -A -v ON_ERROR_STOP=1)

# user n -> 5c000000-0000-4000-8000-<n zero padded to 12>; n = 0 is the owner, 1..11 are grantees
uid() { printf '5c000000-0000-4000-8000-%012d' "$1"; }
OWNER="$(uid 0)"
TRIP="5c000000-0000-4000-8000-00000000f001"

cleanup() {
  "${PSQL[@]}" -c "delete from auth.users where email like '%@concurrency.test'" >/dev/null 2>&1 || true
  "${PSQL[@]}" -c "delete from public.signup_allowlist where email like '%@concurrency.test'" >/dev/null 2>&1 || true
  rm -f "${OUT1:-}" "${OUT2:-}"
}
trap cleanup EXIT
cleanup

OUT1="$(mktemp)"
OUT2="$(mktemp)"

echo "setup: owner, 11 possible grantees, one trip, 9 grantees"
"${PSQL[@]}" <<SQL
insert into public.signup_allowlist (email) select 'u' || g || '@concurrency.test' from generate_series(0, 11) g;
insert into auth.users (id, email, raw_user_meta_data, aud, role)
select ('5c000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'u' || g || '@concurrency.test', '{}', 'authenticated', 'authenticated'
  from generate_series(0, 11) g;
insert into public.trips (id, owner_id, dest_kind, dest_name, length_days)
  values ('$TRIP', '$OWNER', 'freetext', 'Concurrency trip', 3);
select count(*) from generate_series(1, 9) g,
  lateral public.share_resource('$OWNER', 'trip', '$TRIP', ('5c000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'read');
SQL

echo "session 1: shares with grantee 10 and keeps the transaction open for 3 seconds"
"${PSQL[@]}" >"$OUT1" 2>&1 <<SQL &
begin;
set local role service_role;
select created from public.share_resource('$OWNER', 'trip', '$TRIP', '$(uid 10)', 'read');
select pg_sleep(3);
commit;
SQL
PID1=$!
sleep 1

echo "session 2: shares with grantee 11 while session 1 holds the lock"
START=$(date +%s)
set +e
"${PSQL[@]}" -c "set role service_role; select created from public.share_resource('$OWNER', 'trip', '$TRIP', '$(uid 11)', 'read')" >"$OUT2" 2>&1
STATUS2=$?
set -e
END=$(date +%s)
wait "$PID1"

FAILED=0
fail() { echo "FAIL: $1"; FAILED=1; }

grep -qx 't' "$OUT1" || fail "session 1 did not create its share row (output: $(cat "$OUT1"))"
[ "$STATUS2" -ne 0 ] || fail "session 2 succeeded, it must fail with limit_reached (output: $(cat "$OUT2"))"
grep -q 'limit_reached' "$OUT2" || fail "session 2 did not answer limit_reached (output: $(cat "$OUT2"))"
[ $((END - START)) -ge 1 ] || fail "session 2 did not wait on the row lock (took $((END - START)) s)"

COUNT="$("${PSQL[@]}" -c "select count(*) from public.trip_shares where trip_id = '$TRIP'")"
[ "$COUNT" = "10" ] || fail "the trip has $COUNT share rows, expected exactly 10"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "OK: session 2 waited $((END - START)) s, got limit_reached, the trip has exactly 10 share rows"
