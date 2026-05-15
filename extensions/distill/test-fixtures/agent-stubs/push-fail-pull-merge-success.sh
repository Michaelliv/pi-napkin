#!/usr/bin/env bash
# push-fail-pull-merge-success.sh — agent recovers from an origin
# diverge via the spec's pull-merge-push flow.
#
# Scenario (design.md "Mocked-pi behaviors" #8):
#   a. agent commits distilled content on its worktree branch
#   b. agent squashes onto vault's default branch
#   c. agent's first `git push` fails because origin/<default>
#      advanced during the distill (the test harness pre-arranges
#      this by pushing a side commit from a second clone before
#      invoking the wrapper)
#   d. agent runs `git pull --no-rebase origin <default>` to fold
#      origin's commit into local with a merge commit (rebase would
#      violate the design's "never force, never rebase main" rule)
#   e. agent pushes again — succeeds (now fast-forwardable)
#
# The `--no-rebase` is the critical detail: a user with `pull.rebase
# = true` in their global config would silently rewrite local history
# without it, which is exactly what step "Push behavior: never force"
# in the design forbids. The wrapper validates ancestry post-hoc
# (detect_local_only's merge-base check), but the prompt + this
# fixture pin the agent-side enforcement.
#
# Wrapper post-validation: HEAD on default, no markers, 1+ new commit
# on default, origin in sync (push landed) ⇒ `merged-content`.
#
# Reads (env): NAPKIN_STUB_VAULT, NAPKIN_STUB_WORKTREE,
#              NAPKIN_STUB_BRANCH, NAPKIN_STUB_DEFAULT_BRANCH
#
# Side effect for assertion (CORR-1): writes a sentinel file at
# `${NAPKIN_STUB_VAULT}/.napkin-stub-pull-flag` containing the exact
# `git pull` command the fixture executed. The test reads it to pin
# that `--no-rebase` was used (the contract this fixture exists to
# enforce).

set -euo pipefail

VAULT="${NAPKIN_STUB_VAULT:?NAPKIN_STUB_VAULT must be set}"
WORKTREE="${NAPKIN_STUB_WORKTREE:?NAPKIN_STUB_WORKTREE must be set}"
BRANCH="${NAPKIN_STUB_BRANCH:?NAPKIN_STUB_BRANCH must be set}"
DEFAULT_BRANCH="${NAPKIN_STUB_DEFAULT_BRANCH:-main}"

git -C "$VAULT" config user.email "stub@example.com"
git -C "$VAULT" config user.name "stub"
git -C "$WORKTREE" config user.email "stub@example.com"
git -C "$WORKTREE" config user.name "stub"

# (a) commit distilled content on the worktree's distill branch.
echo "# pulled-merged" > "$WORKTREE/pulled-merged.md"
git -C "$WORKTREE" add .
git -C "$WORKTREE" commit -m "distill: pre-push" >/dev/null

# (b) squash onto default in the vault.
git -C "$VAULT" checkout -q "$DEFAULT_BRANCH"
git -C "$VAULT" merge --squash "$BRANCH" >/dev/null 2>&1 || true
git -C "$VAULT" commit -m "distill: squashed" >/dev/null

# Refresh remote-tracking refs so the push can detect a non-ff state.
git -C "$VAULT" fetch origin >/dev/null 2>&1

# (c) first push attempts — expected to fail with non-fast-forward
# because the test harness advanced origin/<default> beyond local's
# fork point. Allow the failure; capture the rc for forensic clarity
# but don't fail the fixture (the agent's recovery is the next step).
PUSH_RC=0
git -C "$VAULT" push origin "$DEFAULT_BRANCH" >/dev/null 2>&1 || PUSH_RC=$?
if [ "$PUSH_RC" -eq 0 ]; then
  echo "push-fail-pull-merge-success: expected first push to fail (non-ff) but it succeeded; test setup didn't advance origin" >&2
  exit 1
fi

# (d) pull --no-rebase to fold origin's advance into local with a
# merge commit. The `--no-rebase` is the design's never-rebase-main
# invariant; record the exact command for the test to assert on.
PULL_CMD="git -C $VAULT pull --no-rebase origin $DEFAULT_BRANCH"
printf '%s\n' "$PULL_CMD" > "$VAULT/.napkin-stub-pull-flag"
git -C "$VAULT" pull --no-rebase --no-edit origin "$DEFAULT_BRANCH" >/dev/null 2>&1

# (e) push again — now fast-forwardable from origin's perspective.
git -C "$VAULT" push origin "$DEFAULT_BRANCH" >/dev/null 2>&1
