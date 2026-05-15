#!/usr/bin/env bash
# squash-skipped.sh — agent commits to the distill branch in the
# worktree but never squashes to the default branch. From the vault's
# perspective, the default branch never moved past startSha.
#
# Wrapper outcome: `validate_commit_count` returns 0 (no new commits
# on default) ⇒ `no-content`. The dangling distill branch lives in
# the reflog (recoverable per the recovery hint in `failed:*`
# sidecars; success-class sidecars don't carry recovery hints).
#
# Reads (env): NAPKIN_STUB_WORKTREE

set -euo pipefail

WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"

git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"
echo "# distill branch only" > "$WORKTREE/dangling.md"
git -C "$WORKTREE" add .
git -C "$WORKTREE" commit -m "distill: branch-only commit (no squash)" >/dev/null
