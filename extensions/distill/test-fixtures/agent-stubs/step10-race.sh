#!/usr/bin/env bash
# step10-race.sh — reproduces the production race between agent step 10
# (worktree removal) and the wrapper's post-validation + outcome-write.
#
# Mirrors a successful distill where the agent:
#   1. Distilled content into the worktree (steps 1–6 of distill-prompt.md)
#   2. Merged main into the distill branch + squash-merged to main (steps 7–9)
#   3. Removes the worktree itself (step 10) — THIS opens the race window
#
# After step 10 the worktree path no longer exists on disk, but the wrapper
# is still blocked on the agent subprocess (the `pi` invocation has not
# returned). The JS-side poller in `runDistillWith` ticks every ~2 s in
# production and observes worktree-gone in the gap between step 10 and
# the wrapper's `write_outcome` call. It then calls `checkOutcome`, which
# returns null because the sidecar hasn't been written yet. The result is
# a false "Distillation terminated abnormally — no outcome record"
# notification on a successful merged-content distill.
#
# We sleep AFTER the worktree removal but BEFORE the stub exits to widen
# the window deterministically. Real-LLM runs see ~1m47s of agent
# follow-up work in this gap; 0.5 s here is enough to beat the
# regression test's 50 ms JS-side poll interval reliably without
# slowing the test suite.
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

# Steps 7–9 effect: a single squash commit lands on default. We commit
# directly in the vault (not the worktree) because the wrapper post-
# validation only inspects the vault — the distinction doesn't matter
# for the race we're reproducing. validate_commit_count will see
# count=1, validate_head_on_default sees HEAD on main, validate_no_markers
# sees no markers, so the wrapper's happy-path outcome is `merged-content`.
echo "# distilled (step10-race)" > "$VAULT/distilled-step10-race.md"
git -C "$VAULT" add .
git -C "$VAULT" commit -m "distill: step10-race squash" >/dev/null

# Step 10: agent removes the worktree itself. `--force` because the
# wrapper installed a napkin shim under the worktree's gitignored
# `.napkin/distill/bin/`, which `git worktree remove` would otherwise
# refuse over. Best-effort: a no-op if the worktree is already gone
# (defensive against test scaffolding double-remove).
git -C "$VAULT" worktree remove --force "$WORKTREE" 2>/dev/null || true
git -C "$VAULT" branch -D "$BRANCH" 2>/dev/null || true

# Widen the race window: keep the agent subprocess alive long enough
# that any JS-side poll interval (50 ms in the regression test, ~2 s
# in production) observes worktree-gone before the wrapper resumes
# post-validation.
sleep 0.5
