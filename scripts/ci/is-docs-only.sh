#!/bin/sh
# is-docs-only.sh - decide whether a list of changed files is documentation only.
# Reads file paths (one per line) on stdin. POSIX sh; same logic for GitHub Actions and Vercel.
#
# Exit 0: every path is docs  (anything below docs/, or a *.md file in the repo root)
# Exit 1: at least one other path, OR the list is empty (fail safe: "unknown" means "run everything")
# Exit 2: usage error
#
# Deliberately NOT docs: .github/**, package*.json, supabase/**, messages/**, .coderabbit.yaml,
# vercel.json, scripts/**, and markdown files in folders other than docs/ (src/, supabase/, ...).
set -eu

case "${1:-}" in
  -h|--help)
    sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
    echo
    echo "Example: git diff --name-only origin/main...HEAD | scripts/ci/is-docs-only.sh"
    exit 0 ;;
  "") ;;
  *) echo "is-docs-only: ERROR: unknown argument '$1' (try --help)" >&2; exit 2 ;;
esac

seen=0
while IFS= read -r path; do
  [ -n "$path" ] || continue
  seen=1
  case "$path" in
    docs/*) ;;                 # anything below docs/ (incl. docs/email-templates/*.html)
    */*) exit 1 ;;             # any other folder, incl. .github/, supabase/, messages/
    *.md) ;;                   # README.md, CLAUDE.md, ... in the repo root
    *) exit 1 ;;               # package.json, .coderabbit.yaml, vercel.json, ...
  esac
done
[ "$seen" -eq 1 ] || exit 1    # empty diff: cannot tell, so do not skip anything
exit 0
