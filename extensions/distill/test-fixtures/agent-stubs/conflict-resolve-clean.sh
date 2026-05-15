#!/usr/bin/env bash
# conflict-resolve-clean.sh — agent encounters a merge conflict and
# resolves it cleanly. Simulates the full integrate-and-squash flow:
#
#   a. agent commits content on the distill branch (in the worktree)
#   b. simulates main moving forward with a conflicting change
#      (this mimics what would happen if a concurrent commit landed
#      while distill ran; in real life the test harness or another
#      writer would advance main, here the fixture itself does it
#      for self-containment)
#   c. agent runs `git merge <default>` from the worktree, hits
#      a conflict, resolves by overwriting the file with merged
#      content, commits the merge
#   d. agent squashes the distill branch to main
#
# Wrapper post-validation: HEAD on default, no markers (resolution
# was clean), 1+ new commit ⇒ `merged-content`.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_WORKTREE,
#              NAPKIN_STUB_BRANCH, NAPKIN_STUB_DEFAULT_BRANCH

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
BRANCH="${NAPKIN_STUB_BRANCH:?NAPKIN_STUB_BRANCH must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"
git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

# (a) agent commits content on the distill branch (in the worktree).
echo "# distill side" > "$WORKTREE/note.md"
git -C "$WORKTREE" add .
git -C "$WORKTREE" commit -m "distill: side branch content" >/dev/null

# (b) main advances with a conflicting change for the same file.
echo "# main side" > "$VAULT/note.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "concurrent edit on $DEFAULT_BRANCH" >/dev/null

# (c) merge into the worktree's distill branch. Force a conflict by
# attempting the merge; we expect non-zero from `git merge` here, so
# allow it via `|| true`. Then overwrite with the resolved content
# and commit.
git -C "$WORKTREE" merge --no-edit "$DEFAULT_BRANCH" || true
cat > "$WORKTREE/note.md" <<'RESOLVED'
# merged distill + main
both sides incorporated
RESOLVED
git -C "$WORKTREE" add .
git -C "$WORKTREE" commit --no-edit -m "merge: resolve conflict" >/dev/null

# (d) squash the distill branch into main from the vault.
git -C "$VAULT" checkout -q "$DEFAULT_BRANCH"
git -C "$VAULT" merge --squash "$BRANCH" >/dev/null 2>&1 || true
git -C "$VAULT" commit -m "distill: with conflict resolved" >/dev/null
