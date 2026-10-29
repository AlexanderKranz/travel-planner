#!/usr/bin/env bash
# Prints KEY=VALUE lines for the E2E run, read from a RUNNING local Supabase (`supabase start`).
# CI:    scripts/e2e/env.sh >> "$GITHUB_ENV"
# Local: set -a; eval "$(scripts/e2e/env.sh)"; set +a
# Only the well-known local demo keys are printed; nothing here can point at a remote project.
set -euo pipefail
eval "$(supabase status -o env)"
echo "NEXT_PUBLIC_SUPABASE_URL=${API_URL}"
echo "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=${ANON_KEY:-${PUBLISHABLE_KEY:-}}"
echo "SUPABASE_SECRET_KEY=${SERVICE_ROLE_KEY:-${SECRET_KEY:-}}"
