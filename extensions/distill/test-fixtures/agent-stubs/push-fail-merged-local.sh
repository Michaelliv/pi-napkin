#!/usr/bin/env bash
# push-fail-merged-local.sh — agent commits but doesn't push. Origin
# is configured (test harness sets up a bare repo + initial push).
# After the agent commits, local <default> is ahead of origin/<default>
# in a fast-forward way (origin is an ancestor of local).
#
# Wrapper outcome: `detect_local_only` finds local != origin AND
# origin is an ancestor of local ⇒ `merged-local` (warning class).
#
# Reads (env): NAPKIN_STUB_VAULT

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

echo "# local-only" > "$VAULT/local-only.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: local-only" >/dev/null

# Deliberately do NOT push. The agent's prompt instructs it to push
# if origin exists, but real-world push failures (auth, network, etc.)
# leave the wrapper to surface the warning class.
