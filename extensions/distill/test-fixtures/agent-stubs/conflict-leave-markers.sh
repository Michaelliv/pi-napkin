#!/usr/bin/env bash
# conflict-leave-markers.sh — agent fails to fully resolve conflict
# markers and commits a file containing all 3 marker types directly
# on the default branch. Wrapper post-validation detects the markers
# and dispatches `failed:markers-after-agent-exit`.
#
# Reads (env): NAPKIN_STUB_VAULT

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"
cat > "$VAULT/conflict.md" <<'MARKERS'
# header
<<<<<<< HEAD
local content
=======
remote content
>>>>>>> feature
trailing
MARKERS
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: with markers" >/dev/null
