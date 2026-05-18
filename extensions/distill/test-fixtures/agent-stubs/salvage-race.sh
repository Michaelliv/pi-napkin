#!/usr/bin/env bash
# salvage-race.sh — stub-pi that triggers the wrapper's salvage path
# by leaving conflict markers in vault `*.md` files, then exits 0.
#
# Used by wrapper-invariant.test.ts's salvage-path case. The stub:
#   1. Commits content with literal `<<<<<<<` / `=======` / `>>>>>>>`
#      markers in a vault `*.md` file (so the squash-commit lands on
#      the default branch, but `validate_no_markers` will reject it).
#   2. Exits 0 — the stub itself doesn't error; the failure surfaces
#      in the wrapper's post-validation step.
#
# Wrapper response: `validate_no_markers` finds the markers, returns
# non-zero, and the wrapper enters `salvage("markers-after-agent-exit")`.
# The salvage path:
#   - cd's out of the worktree
#   - removes the worktree (this is the moment the test polls)
#   - composes a recovery hint
#   - writes the `failed:markers-after-agent-exit` outcome sidecar
#
# The wrapper invariant ('write_outcome runs before any worktree-
# removal step anywhere in the wrapper') requires the salvage code to
# write the outcome BEFORE removing the worktree. The test confirms
# this by snapshotting the outcome file at the moment the worktree
# disappears.
#
# Race-window widening: the salvage path's race is INSIDE the wrapper
# itself (between `git worktree remove` returning and `write_outcome`
# being called), so a stub-side `sleep` can't widen it. The test
# instead PATH-shims `git` with `slow-git.sh`, which delays the return
# of `git worktree remove` by 0.5 s AFTER the real removal completes.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_WORKTREE,
#              NAPKIN_STUB_BRANCH, NAPKIN_STUB_DEFAULT_BRANCH (default: main)

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
BRANCH="${NAPKIN_STUB_BRANCH:?NAPKIN_STUB_BRANCH must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"

# Commit a file containing literal conflict markers. We commit
# directly in the vault (not the worktree) because the wrapper's
# `validate_no_markers` scans the vault — same shape as the
# happy-path stub's commit, just with corrupt content.
#
# The marker triple must be complete (<<<<<<< / ======= / >>>>>>>)
# to match `list_marker_files`'s scanner; partial markers don't
# trigger the validator.
cat > "$VAULT/distilled-with-markers.md" <<'MD'
# distilled (salvage-race)

<<<<<<< HEAD
This is the local side.
=======
This is the incoming side.
>>>>>>> distill/abc-123
MD

git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: salvage-race squash with markers" >/dev/null

# Exit cleanly. The wrapper's post-validation will detect the markers
# and route into salvage().
