#!/usr/bin/env bash
# Concurrency tests for public.share_resource (docs/specs/sharing.md section 5, decision D25) and for the group
# sharing functions (docs/specs/group-sharing.md section 5).
# Case 1 (trip cap): two psql sessions share the same trip with two different NEW grantees while the trip already has
# 9 grantees. The first session holds its transaction open; the second one must wait on the row lock of step 3 and,
# after the first commits, answer limit_reached. Afterwards the trip has exactly 10 share rows.
# Case 2 (group cap): the same race for a group with 9 grantees, through share_resource('group').
# Case 3 (same entry): two users claim the same entry; the second one answers already_linked.
# Case 4 (same user): one user claims two entries of a group in two sessions; the second one answers already_claimed
# and exactly one link exists.
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

# Explicit synchronization (no fixed sleeps): poll pg_stat_activity by application_name.
# wait_for <sql returning a count>: up to 30 s for the count to be > 0.
wait_for() {
  for _ in $(seq 1 300); do
    [ "$("${PSQL[@]}" -c "$1")" -gt 0 ] && return 0
    sleep 0.1
  done
  return 1
}

# A gate session holds an advisory lock; session 1 blocks on it after share_resource (so it keeps the trip's row
# lock) until the gate is ended, which happens only once session 2 is seen waiting on that row lock.
GATE=424242
echo "gate: holds advisory lock $GATE"
PGAPPNAME=share-gate "${PSQL[@]}" -c "select pg_advisory_lock($GATE); select pg_sleep(120);" >/dev/null 2>&1 &
PIDG=$!
wait_for "select count(*) from pg_locks l join pg_stat_activity a using (pid) where a.application_name = 'share-gate' and l.locktype = 'advisory' and l.granted" \
  || { kill "$PIDG" 2>/dev/null; echo "FAIL: the gate never took its lock"; exit 1; }

echo "session 1: shares with grantee 10, then waits on the gate with its transaction open"
PGAPPNAME=share-s1 "${PSQL[@]}" >"$OUT1" 2>&1 <<SQL &
begin;
set local role service_role;
select created from public.share_resource('$OWNER', 'trip', '$TRIP', '$(uid 10)', 'read');
reset role;
select pg_advisory_lock($GATE) is not null as gate_passed;
commit;
SQL
PID1=$!
# Session 1 waiting on the advisory lock means share_resource returned and the trip row lock is held.
wait_for "select count(*) from pg_stat_activity where application_name = 'share-s1' and wait_event_type = 'Lock'" \
  || { kill "$PID1" "$PIDG" 2>/dev/null; echo "FAIL: session 1 never reached the gate (output: $(cat "$OUT1"))"; exit 1; }

echo "session 2: shares with grantee 11 while session 1 holds the row lock"
PGAPPNAME=share-s2 "${PSQL[@]}" -c "set role service_role; select created from public.share_resource('$OWNER', 'trip', '$TRIP', '$(uid 11)', 'read')" >"$OUT2" 2>&1 &
PID2=$!
WAITED=0
wait_for "select count(*) from pg_stat_activity where application_name = 'share-s2' and wait_event_type = 'Lock'" && WAITED=1

# Open the gate: ending the gate session releases its advisory lock, session 1 commits, session 2 continues.
"${PSQL[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'share-gate'" >/dev/null
set +e
wait "$PIDG"
wait "$PID1"
wait "$PID2"
STATUS2=$?
set -e

FAILED=0
fail() { echo "FAIL: $1"; FAILED=1; }

grep -qx 't' "$OUT1" || fail "session 1 did not create its share row (output: $(cat "$OUT1"))"
[ "$STATUS2" -ne 0 ] || fail "session 2 succeeded, it must fail with limit_reached (output: $(cat "$OUT2"))"
grep -q 'limit_reached' "$OUT2" || fail "session 2 did not answer limit_reached (output: $(cat "$OUT2"))"
[ "$WAITED" -eq 1 ] || fail "session 2 was never seen waiting on the row lock"

COUNT="$("${PSQL[@]}" -c "select count(*) from public.trip_shares where trip_id = '$TRIP'")"
[ "$COUNT" = "10" ] || fail "the trip has $COUNT share rows, expected exactly 10"

rm -f "$OUT1" "$OUT2"

# ---------- generic race for the group cases ----------
# run_race <tag> <sql for session 1, inside a transaction> <sql for session 2, one psql -c string = one transaction>
# Session 1 runs its SQL, then waits on the gate with its transaction (and its locks) open. Session 2 starts once
# session 1 waits, and must be seen waiting on a lock before the gate opens. Sets RACE_OUT1, RACE_OUT2, RACE_STATUS2,
# RACE_WAITED. No fixed sleeps.
run_race() {
  local tag="$1" sql1="$2" sql2="$3" pidg pid1 pid2
  RACE_OUT1="$(mktemp)"
  RACE_OUT2="$(mktemp)"
  PGAPPNAME="gate-$tag" "${PSQL[@]}" -c "select pg_advisory_lock($GATE); select pg_sleep(120);" >/dev/null 2>&1 &
  pidg=$!
  wait_for "select count(*) from pg_locks l join pg_stat_activity a using (pid) where a.application_name = 'gate-$tag' and l.locktype = 'advisory' and l.granted" \
    || { kill "$pidg" 2>/dev/null; echo "FAIL ($tag): the gate never took its lock"; exit 1; }

  PGAPPNAME="s1-$tag" "${PSQL[@]}" >"$RACE_OUT1" 2>&1 <<SQL &
begin;
$sql1
reset role;
select pg_advisory_lock($GATE) is not null as gate_passed;
commit;
SQL
  pid1=$!
  wait_for "select count(*) from pg_stat_activity where application_name = 's1-$tag' and wait_event_type = 'Lock'" \
    || { kill "$pid1" "$pidg" 2>/dev/null; echo "FAIL ($tag): session 1 never reached the gate (output: $(cat "$RACE_OUT1"))"; exit 1; }

  PGAPPNAME="s2-$tag" "${PSQL[@]}" -c "$sql2" >"$RACE_OUT2" 2>&1 &
  pid2=$!
  RACE_WAITED=0
  wait_for "select count(*) from pg_stat_activity where application_name = 's2-$tag' and wait_event_type = 'Lock'" && RACE_WAITED=1

  "${PSQL[@]}" -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name = 'gate-$tag'" >/dev/null
  set +e
  wait "$pidg"
  wait "$pid1"
  wait "$pid2"
  RACE_STATUS2=$?
  set -e
}

# Test data for the group cases (committed; removed again by cleanup: the users, and with them the groups, go).
GCAP="5c000000-0000-4000-8000-00000000f102"
GRP="5c000000-0000-4000-8000-00000000f103"
GRP2="5c000000-0000-4000-8000-00000000f104"
ENT_X="5c000000-0000-4000-8000-00000000f1a1"
ENT_X2="5c000000-0000-4000-8000-00000000f1a2"
ENT_Y2="5c000000-0000-4000-8000-00000000f1a3"
echo "setup: groups for the group cases"
"${PSQL[@]}" <<SQL >/dev/null
insert into public.travel_groups (id, owner_id, name) values
  ('$GCAP', '$OWNER', 'Concurrency cap group'), ('$GRP', '$OWNER', 'Concurrency claim group'), ('$GRP2', '$OWNER', 'Concurrency two-entry group');
insert into public.group_entries (id, group_id, owner_id, kind, name) values
  ('$ENT_X', '$GRP', '$OWNER', 'member', 'X'), ('$ENT_X2', '$GRP2', '$OWNER', 'member', 'X2'), ('$ENT_Y2', '$GRP2', '$OWNER', 'member', 'Y2');
select count(*) from generate_series(1, 9) g,
  lateral public.share_resource('$OWNER', 'group', '$GCAP', ('5c000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'read');
select public.share_resource('$OWNER', 'group', '$GRP', '$(uid 10)', 'read');
select public.share_resource('$OWNER', 'group', '$GRP', '$(uid 11)', 'read');
select public.share_resource('$OWNER', 'group', '$GRP2', '$(uid 1)', 'read');
SQL

# ---------- case 2: the 10-cap for groups ----------
echo "case 2: two sessions share a group with 9 grantees with two new users"
run_race group-cap \
  "set local role service_role; select created from public.share_resource('$OWNER', 'group', '$GCAP', '$(uid 10)', 'read');" \
  "set local role service_role; select created from public.share_resource('$OWNER', 'group', '$GCAP', '$(uid 11)', 'read');"
grep -qx 't' "$RACE_OUT1" || fail "case 2: session 1 did not create its share row (output: $(cat "$RACE_OUT1"))"
[ "$RACE_STATUS2" -ne 0 ] || fail "case 2: session 2 succeeded, it must fail with limit_reached (output: $(cat "$RACE_OUT2"))"
grep -q 'limit_reached' "$RACE_OUT2" || fail "case 2: session 2 did not answer limit_reached (output: $(cat "$RACE_OUT2"))"
[ "$RACE_WAITED" -eq 1 ] || fail "case 2: session 2 was never seen waiting on the row lock"
COUNT="$("${PSQL[@]}" -c "select count(*) from public.group_shares where group_id = '$GCAP'")"
[ "$COUNT" = "10" ] || fail "case 2: the group has $COUNT share rows, expected exactly 10"
rm -f "$RACE_OUT1" "$RACE_OUT2"

# claim_sql <user n> <entry id>: act as that user (user JWT claims) and claim the entry.
claim_sql() {
  printf "set local role authenticated; select set_config('request.jwt.claims', '{\"sub\":\"%s\",\"role\":\"authenticated\"}', true); select public.claim_group_entry('%s');" "$(uid "$1")" "$2"
}

# ---------- case 3: two users claim the same entry ----------
echo "case 3: two users claim the same entry"
run_race claim-same "$(claim_sql 10 "$ENT_X")" "$(claim_sql 11 "$ENT_X")"
grep -q "$GRP" "$RACE_OUT1" || fail "case 3: session 1 did not claim the entry (output: $(cat "$RACE_OUT1"))"
[ "$RACE_STATUS2" -ne 0 ] || fail "case 3: session 2 succeeded, it must fail with already_linked (output: $(cat "$RACE_OUT2"))"
grep -q 'already_linked' "$RACE_OUT2" || fail "case 3: session 2 did not answer already_linked (output: $(cat "$RACE_OUT2"))"
[ "$RACE_WAITED" -eq 1 ] || fail "case 3: session 2 was never seen waiting on the row lock"
LINK="$("${PSQL[@]}" -c "select linked_user_id from public.group_entries where id = '$ENT_X'")"
[ "$LINK" = "$(uid 10)" ] || fail "case 3: the entry is linked to '$LINK', expected the first claimer"
rm -f "$RACE_OUT1" "$RACE_OUT2"

# ---------- case 4: one user claims two entries of the same group ----------
echo "case 4: one user claims two entries in two sessions"
run_race claim-two "$(claim_sql 1 "$ENT_X2")" "$(claim_sql 1 "$ENT_Y2")"
grep -q "$GRP2" "$RACE_OUT1" || fail "case 4: session 1 did not claim its entry (output: $(cat "$RACE_OUT1"))"
[ "$RACE_STATUS2" -ne 0 ] || fail "case 4: session 2 succeeded, it must fail with already_claimed (output: $(cat "$RACE_OUT2"))"
grep -q 'already_claimed' "$RACE_OUT2" || fail "case 4: session 2 did not answer already_claimed (output: $(cat "$RACE_OUT2"))"
[ "$RACE_WAITED" -eq 1 ] || fail "case 4: session 2 was never seen waiting (on the unique index)"
LINKS="$("${PSQL[@]}" -c "select count(*) from public.group_entries where group_id = '$GRP2' and linked_user_id is not null")"
[ "$LINKS" = "1" ] || fail "case 4: $LINKS links exist, expected exactly one"
rm -f "$RACE_OUT1" "$RACE_OUT2"

if [ "$FAILED" -ne 0 ]; then
  exit 1
fi
echo "OK: trip cap, group cap, same-entry claim and same-user claim all behaved under concurrency"
