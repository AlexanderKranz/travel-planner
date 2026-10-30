#!/bin/sh
# test-docs-only.sh - self-test for is-docs-only.sh and vercel-ignore-build.sh.
# Builds a throwaway git repo in a temp dir (no network, nothing in this repo is touched).
# Run: sh scripts/ci/test-docs-only.sh   Exit 0 = all passed.
set -eu

case "${1:-}" in
  -h|--help) sed -n '2,4p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

root=$(cd "$(dirname "$0")/../.." && pwd)
classify="$root/scripts/ci/is-docs-only.sh"
ignore="$root/scripts/vercel-ignore-build.sh"
fail=0

# expect WANT_EXIT "label" -- printf-format-input
check_list() {
  want=$1; label=$2; input=$3
  got=0; printf '%b' "$input" | sh "$classify" || got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $label"; else echo "FAIL $label (exit $got, want $want)"; fail=1; fi
}

check_list 0 "docs + root md"            'docs/a.md\nREADME.md\nCLAUDE.md\n'
check_list 0 "email template html"       'docs/email-templates/invite.html\n'
check_list 1 "workflow change"           'docs/a.md\n.github/workflows/ci.yml\n'
check_list 1 "package.json"              'package.json\n'
check_list 1 "package-lock.json + docs"  'docs/a.md\npackage-lock.json\n'
check_list 1 "migration"                 'supabase/migrations/1.sql\n'
check_list 1 "messages"                  'messages/de.json\n'
check_list 1 ".coderabbit.yaml"          '.coderabbit.yaml\n'
check_list 1 "vercel.json"               'vercel.json\n'
check_list 1 "md outside docs/"          'src/notes.md\n'
check_list 1 "docs-like prefix"          'docs-old/a.md\nmydocs/a.md\n'
check_list 1 "empty list (fail safe)"    ''

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM
cd "$tmp"
git init -q .
git config user.email t@example.invalid; git config user.name t
mkdir -p scripts/ci docs src
cp "$classify" scripts/ci/is-docs-only.sh
cp "$ignore" scripts/vercel-ignore-build.sh
echo a > src/a.ts; echo a > docs/a.md
git add -A; git commit -q -m base

check_vercel() {
  want=$1; label=$2; envv=$3
  got=0; VERCEL_ENV=$envv sh scripts/vercel-ignore-build.sh >/dev/null || got=$?
  if [ "$got" -eq "$want" ]; then echo "ok   $label"; else echo "FAIL $label (exit $got, want $want)"; fail=1; fi
}

echo b >> docs/a.md; echo x > NOTES.md; git add -A; git commit -q -m docs
check_vercel 0 "vercel: preview + docs-only commit skips"      preview
check_vercel 1 "vercel: production + docs-only commit builds"  production
check_vercel 1 "vercel: VERCEL_ENV unset builds"               ""
echo b >> src/a.ts; git add -A; git commit -q -m code
check_vercel 1 "vercel: preview + code commit builds"          preview
git mv docs/a.md src/a.md; git commit -q -m move
check_vercel 1 "vercel: rename out of docs builds"             preview
git checkout -q --orphan fresh; git add -A; git commit -q -m first
check_vercel 1 "vercel: no parent commit builds"               preview
rm -rf .git
check_vercel 1 "vercel: no git data builds"                    preview

[ "$fail" -eq 0 ] && echo "all passed" || { echo "SOME TESTS FAILED"; exit 1; }
