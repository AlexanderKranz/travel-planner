#!/bin/sh
# vercel-ignore-build.sh - Vercel "Ignored Build Step" (see ignoreCommand in vercel.json).
# Exit 0 = skip this build, exit 1 = build (Vercel docs, checked 2026-10-31:
# https://vercel.com/docs/project-configuration/vercel-json#ignorecommand).
#
# Skips ONLY preview deployments whose last commit (HEAD^ -> HEAD) changed documentation only.
# Production, unknown environments, missing git history, or any error: build.
# Vercel clones shallow (depth about 10), so only the last commit is compared, not the whole PR.
#
# Needs: git, scripts/ci/is-docs-only.sh. Env: VERCEL_ENV (set by Vercel). Writes no files.
set -eu

case "${1:-}" in
  -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
esac

build() { echo "vercel-ignore-build: building ($*)"; exit 1; }

[ "${VERCEL_ENV:-}" = "preview" ] || build "VERCEL_ENV='${VERCEL_ENV:-unset}' is not preview"

here=$(dirname "$0")
[ -f "$here/ci/is-docs-only.sh" ] || build "classifier script missing"

# Merge commits are fine (HEAD^ = first parent, usually many files -> build). No parent -> build.
git rev-parse --verify --quiet HEAD^ >/dev/null 2>&1 || build "no parent commit available"
files=$(git diff --name-only --no-renames HEAD^ HEAD 2>/dev/null) || build "git diff failed"

if printf '%s\n' "$files" | sh "$here/ci/is-docs-only.sh"; then
  echo "vercel-ignore-build: docs-only change, skipping preview build"
  exit 0
fi
build "code or config changed"
