#!/usr/bin/env bash
# clean-distill.sh — happy path. Agent commits one file directly on the
# default branch in the vault, then exits. Wrapper post-validation
# passes (HEAD on default, no markers, 1 new commit). No origin
# configured ⇒ `merged-content`.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_DEFAULT_BRANCH (default: main)

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"
echo "# distilled" > "$VAULT/distilled.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: clean" >/dev/null
