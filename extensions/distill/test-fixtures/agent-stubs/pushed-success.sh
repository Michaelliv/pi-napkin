#!/usr/bin/env bash
# pushed-success.sh — agent commits to the default branch and pushes
# to origin. The test harness pre-configures origin (bare repo) +
# initial push so origin/<default> is reachable.
#
# Wrapper outcome: `detect_local_only` finds local == origin ⇒
# `merged-content` (no `merged-local` because the push landed).
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_DEFAULT_BRANCH

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

echo "# pushed" > "$VAULT/pushed.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: pushed" >/dev/null

# Push to origin. Origin is configured by the test harness.
git -C "$VAULT" push origin "$DEFAULT_BRANCH" >/dev/null 2>&1
