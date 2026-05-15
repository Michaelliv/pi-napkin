#!/usr/bin/env bash
# multiple-commits-on-main.sh — agent makes 2+ commits directly on the
# default branch. The wrapper's `validate_commit_count` accepts any
# `>= 1` count (the dispatch is no-content vs has-content); design
# notes the squash-invariant is a soft suggestion, not a hard
# constraint.
#
# Wrapper outcome: 2 new commits on default ⇒ `merged-content`.
#
# Reads (env): NAPKIN_STUB_VAULT

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

echo "# first" > "$VAULT/first.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: first" >/dev/null

echo "# second" > "$VAULT/second.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: second" >/dev/null
