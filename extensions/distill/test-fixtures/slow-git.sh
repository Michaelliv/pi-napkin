#!/usr/bin/env bash
# slow-git: PATH shim that delays `git worktree remove` by 0.5 s AFTER
# the real git completes, opening a deterministic race window for
# wrapper-invariant.test.ts's salvage-path case.
#
# Ordering: exec-then-sleep. The shim runs the real `git` FIRST so the
# worktree disappears immediately, THEN sleeps 0.5 s before returning
# to the wrapper. This widens the wall-time gap between worktree-gone
# and the wrapper's subsequent `write_outcome` call. Reverse-ordering
# (sleep-then-exec) would NOT open the race window — the worktree
# wouldn't disappear until AFTER the sleep, and the wrapper would
# resume at normal speed once it does.
#
# Pass-through for everything that isn't `worktree remove`. The test
# only needs to widen the post-removal gap; other git operations run
# at normal speed.
#
# Setup contract (test-side):
#   1. Set NAPKIN_SLOW_GIT_REAL_GIT to the absolute path of the real
#      `git` binary (e.g. via `which git` BEFORE PATH is mutated).
#   2. Stage this script as `<tmpdir>/git` (symlink or copy with
#      mode 0755). The basename MUST be `git` so the wrapper's bare
#      `git ...` invocations resolve through PATH to this shim.
#   3. Prepend `<tmpdir>` to PATH before spawning the wrapper.
#   4. After the wrapper exits, restore PATH and rm -rf the tmpdir.
#
# Setting NAPKIN_SLOW_GIT_REAL_GIT explicitly avoids PATH-introspection
# edge cases (BASH_SOURCE+symlink resolution, recursive shim lookup).
# The test resolves the real git via `which git` once, before mutating
# PATH; the shim trusts that absolute path.
#
# Cross-platform: tested on Linux (bash 5.x) and macOS (bash 3.2 +
# Homebrew bash 5.x). `sleep 0.5` is supported on both GNU coreutils
# and BSD `sleep` (macOS).

set -euo pipefail

REAL_GIT="${NAPKIN_SLOW_GIT_REAL_GIT:?NAPKIN_SLOW_GIT_REAL_GIT must be set to the absolute path of the real git binary}"

if [ ! -x "$REAL_GIT" ]; then
  echo "slow-git: NAPKIN_SLOW_GIT_REAL_GIT='$REAL_GIT' is not an executable file" >&2
  exit 127
fi

# Detect `worktree remove` by scanning argv for the two-token sequence
# `worktree remove`. Single-token match (`worktree`) is too loose —
# `git worktree list` shouldn't be slowed.
prev=""
is_worktree_remove=false
for arg in "$@"; do
  if [ "$prev" = "worktree" ] && [ "$arg" = "remove" ]; then
    is_worktree_remove=true
    break
  fi
  prev="$arg"
done

if $is_worktree_remove; then
  "$REAL_GIT" "$@"
  rc=$?
  # Widens the [worktree-gone, write_outcome-called] race window.
  # 0.5 s is enough to beat the wrapper-invariant test's 50 ms JS-side
  # poll interval reliably without slowing the test suite.
  sleep 0.5
  exit "$rc"
fi

exec "$REAL_GIT" "$@"
