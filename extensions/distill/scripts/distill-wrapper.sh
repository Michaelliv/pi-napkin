#!/usr/bin/env bash
# distill-wrapper — orchestrates a single auto-distill attempt inside a
# per-distill git worktree.
#
# PR #12 architecture: the distill AGENT owns distill content production
# AND the integration phases (merge, squash, push, cleanup). The wrapper
# is a thin shell:
#   1. Worktree setup is already done by createDistillWorkspace before
#      this script runs (git worktree add, session fork, meta.json).
#   2. Wrapper installs the napkin shim (POST-R6-CACHE), cds to PARENT_CWD
#      for cache parity, then invokes `pi --session ... -p $PROMPT` ONCE
#      under a hard `timeout(1)` budget.
#   3. Agent executes the full agent-driven prompt (extensions/distill/
#      distill-prompt.md): distill content + git merge + git merge --squash
#      + git push + git worktree remove + git branch -D.
#   4. Post-agent-exit, wrapper validates the agent's output (markers
#      absent, HEAD on default, commit count) and salvages on failure.
#   5. Wrapper writes the outcome sidecar and exits.
#
# Implementation history: validation (A3) and salvage (A4) landed in
# commits afed6ae and 0d0a262 respectively. The numbered lifecycle
# below reflects the current shape; see git log for the staged
# rollout.
#
# Usage:
#   distill-wrapper.sh <vault> <worktree> <branch> <sessionFork> <prompt> <errorDir> [<model>] [<defaultBranch>] [<parentCwd>] [<maxDurationSecs>] [<expectedCacheRoot>]
#
# Arguments:
#   <vault>          absolute path to the main vault (NOT the worktree)
#   <worktree>       absolute path to the distill worktree (lives under
#                    `$XDG_CACHE_HOME/napkin-distill/<vault-hash>/<suffix>/`;
#                    see `resolveCacheRoot` in extensions/distill/distill-workspace.ts)
#   <branch>         distill branch name (`distill/<hex>-<epoch>`)
#   <sessionFork>    absolute path to the forked session .jsonl inside the worktree
#   <prompt>         resolved agent-driven distill prompt (steps 1–10 with
#                    placeholders already substituted by `buildDistillPrompt`)
#   <errorDir>       absolute path to `<vault.configPath>/distill/errors/`
#   <model>          optional "<provider>/<id>" to pass to `pi --model`
#   <defaultBranch>  optional name of the vault's mainline branch (e.g. `main`,
#                    `master`). When empty/absent, defaults to `main`. The JS
#                    side resolves this via `git symbolic-ref refs/remotes/origin/HEAD`
#                    or a HEAD-ref lookup so the wrapper doesn't hardcode `main`.
#   <parentCwd>      REQUIRED. Absolute path of the parent pi session's cwd.
#                    Pi is spawned at this cwd so the system prompt's
#                    `Current working directory:` line is byte-identical
#                    to the parent's, preserving prompt-cache hits. Vault
#                    writes are still routed to the worktree via the
#                    napkin shim installed at
#                    `<worktree>/.napkin/distill/bin/napkin`. The wrapper
#                    hard-fails if this is empty (R7-PERF-7, R7-CI-6) —
#                    silently falling back to <worktree> would re-
#                    introduce the cache regression POST-R6-CACHE fixed.
#   <maxDurationSecs> hard wall-clock budget for the agent task, in
#                    seconds. Wired into `timeout(1)` so the agent is
#                    SIGTERMed (then SIGKILLed after grace) on overrun.
#                    Required at A2 onward; defaults to 600 (10 minutes)
#                    when absent for backward-compatibility with any
#                    out-of-tree caller still on the 9-arg shape.
#                    Derived from `distill.maxDurationMinutes` config.
#   <expectedCacheRoot> Absolute path to the resolved XDG cache root
#                    (`<XDG_CACHE_HOME or ~/.cache>/napkin-distill/<vault-hash>`)
#                    that contains <worktree>. Used by safe_rm_worktree
#                    to require any path it `rm -rf`s to be a descendant
#                    of THIS root, not just any path containing a
#                    `/napkin-distill/<x>/<y>/` segment (SEC-2 / CORR-3).
#                    Computed JS-side by `resolveCacheRoot()` in
#                    `extensions/distill/distill-workspace.ts` (the same
#                    function that built <worktree>'s parent dir), so the
#                    two sides stay in sync. Optional for backward
#                    compatibility with tests / out-of-tree callers; when
#                    empty/absent, safe_rm_worktree falls back to the
#                    cache-segment-glob check (Pass 1A behaviour).
#
# Lifecycle (happy path, PR #12):
#   1. install napkin shim at <worktree>/.napkin/distill/bin/napkin and
#      prepend it to PATH (auto-routes agent napkin calls to the worktree)
#   2. cd <parentCwd>                            (cache parity — keeps pi's
#                                                 system prompt cwd line
#                                                 byte-identical to parent's)
#   3. timeout <maxDurationSecs> pi --session <sessionFork> -p <prompt>
#                                                (single agent task: produces
#                                                 content, runs git merge into
#                                                 distill branch, squashes to
#                                                 main, pushes if origin, cleans
#                                                 up worktree+branch — see
#                                                 extensions/distill/distill-prompt.md)
#   4. validate agent output                     (markers, HEAD on default,
#                                                 commit count; see
#                                                 validate_no_markers /
#                                                 validate_head_on_default /
#                                                 validate_commit_count below)
#   5. salvage if validation fails               (force-cleanup worktree+
#                                                 branch + write
#                                                 `failed:<reason>` outcome
#                                                 with recovery hint; see
#                                                 salvage() below)
#   6. write outcome sidecar                     (`merged-content` on happy path;
#                                                 `merged-local` when local diverges
#                                                 from origin; `no-content` on 0
#                                                 commits since startSha; `failed:<reason>`
#                                                 on validation failure)
#   7. cleanup (trap): force-remove worktree, prune, force-delete branch
#
# Error handling:
#   Any fatal failure writes a log entry to:
#     <errorDir>/<ISO-timestamp>-<pid>-<branch-short-hash>.log
#   and proceeds to cleanup. We never `exit` before the trap so worktrees and
#   branches are always torn down.
#
# Environment:
#   NAPKIN_DISTILL_NO_RECURSE=1  exported so the nested `pi` won't auto-distill
#   NAPKIN_GIT_RETRY_MAX         forwarded to git_retry (cleanup paths only)
#   NAPKIN_GIT_RETRY_DELAY       forwarded to git_retry (cleanup paths only)
#
# Testing hooks:
#   NAPKIN_DISTILL_PI_BIN        path to a stub `pi` binary (integration tests).
#                                The agent-driven design means tests that want
#                                to simulate specific outcomes (clean-distill,
#                                conflict-leave-markers, agent-timeout, …) do
#                                so via a stub pi that produces the right
#                                filesystem effects on each invocation.
#   NAPKIN_DISTILL_SKIP_PI=1     skip the agent invocation entirely. Tests
#                                that pre-stage filesystem state directly use
#                                this hook; the wrapper proceeds straight to
#                                outcome write. NOTE: at A2 the wrapper still
#                                writes `merged-content` unconditionally on
#                                this path — A3 wires real validation that
#                                fires on the SKIP_PI path too.
#   NAPKIN_DISTILL_HALT_AFTER_META=1
#                                halt right after rewriting meta.json's pid to
#                                the wrapper's pid — lets tests inspect the
#                                updated meta without the cleanup trap
#                                wiping the worktree.
#   NAPKIN_DISTILL_HALT_AFTER_SHIM=1
#                                halt right after the per-distill napkin shim
#                                is installed at <worktree>/.napkin/distill/bin/napkin
#                                — lets tests inspect the shim contents and PATH
#                                injection without the cleanup trap wiping it.
#   NAPKIN_DISTILL_FORCE_CLEANUP=1
#                                trigger the cleanup trap from a controlled
#                                exit point post-shim-install. Unlike the
#                                HALT_AFTER_* hooks this does NOT clear
#                                the EXIT trap — the cleanup function
#                                fires and tests assert on its post-state
#                                (rm-rf fallback, rmdir parent, etc.).
#   NAPKIN_DISTILL_TIMEOUT_KILL_GRACE_SECS=<n>
#                                override TIMEOUT_KILL_GRACE_SECS (the
#                                seconds the SIGTERM→SIGKILL escalation
#                                waits before killing a stuck agent).
#                                Production default is 30s; tests assert
#                                escalation against SIGTERM-ignoring stubs
#                                with a short grace so the assertion
#                                completes within the outer test timeout.

set -uo pipefail

# Resolve our own script dir so we can source git_retry.sh regardless of cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# git_retry.sh is sourced for backward-compat with any out-of-tree
# caller; PR #12's wrapper does not use it directly (the agent owns
# all merge/squash/push retries). Phase B will drop the source line.
# shellcheck source=./git_retry.sh
source "$HERE/git_retry.sh"

# coreutils timeout(1) is required for the agent task's hard wall-clock
# budget. macOS without `brew install coreutils` doesn't ship `timeout`
# at all; Homebrew installs it as `gtimeout` by default. Detect both
# names and prefer whichever is present so the wrapper works on Linux
# (`timeout`) and stock macOS-with-Homebrew-coreutils (`gtimeout`)
# without further configuration. Fail fast with an actionable error if
# neither is on PATH — silently routing through the no-timeout path
# would let a misbehaving agent leak the wrapper indefinitely
# (CI-A-1, CLEAN-A-1, SEC-A-3).
TIMEOUT_BIN="$(command -v timeout || command -v gtimeout || true)"
if [ -z "$TIMEOUT_BIN" ]; then
  echo "distill-wrapper: GNU coreutils timeout(1) not found on PATH (looked for 'timeout' and 'gtimeout'). Install coreutils (e.g. \`brew install coreutils\` on macOS) and re-run." >&2
  exit 2
fi

# SIGKILL escalation grace period: after timeout(1) sends SIGTERM at
# the budget boundary, wait this many seconds before escalating to
# SIGKILL. Without `-k` on the timeout invocation, escalation never
# happens — a SIGTERM-ignoring agent (a stuck-in-libc-syscall pi
# process, a tool subprocess that traps SIGTERM, OOM-killing-deadlock)
# would hang the wrapper indefinitely. 30s is comfortably longer than
# typical SIGTERM-handler shutdown paths and short enough that a
# stuck distill clears within ~30s+budget total. Per the methodology
# guide's never-deferrable magic-number rule.
#
# Tests can override via NAPKIN_DISTILL_TIMEOUT_KILL_GRACE_SECS so a
# SIGTERM-ignoring stub assertion completes within the test timeout
# budget without waiting the full 30s grace.
TIMEOUT_KILL_GRACE_SECS="${NAPKIN_DISTILL_TIMEOUT_KILL_GRACE_SECS:-30}"

VAULT="${1:-}"
WORKTREE="${2:-}"
BRANCH="${3:-}"
SESSION_FORK="${4:-}"
PROMPT="${5:-}"
ERROR_DIR="${6:-}"
MODEL="${7:-}"
DEFAULT_BRANCH="${8:-main}"
PARENT_CWD="${9:-}"
# Default 600s (10 minutes) matches `DEFAULT_MAX_DISTILL_DURATION_MS` in
# extensions/distill/index.ts. The JS side ALWAYS passes a value at A2+,
# so this default exists only for direct test invocations of the wrapper
# that omit the 11th arg.
#
# Magic number rationale: 600 = 10 minutes, the production-default agent
# task budget locked in the PR #12 design ("One configuration knob:
# distill.maxDurationMinutes"). Covers distill content production + merge
# + squash + push + cleanup for typical workloads on a Sonnet-class
# model with ~95s prelude.
DEFAULT_MAX_DURATION_SECS=600
MAX_DURATION_SECS="${10:-$DEFAULT_MAX_DURATION_SECS}"
# SEC-2 / CORR-3: explicit cache root the worktree must live under.
# Empty string means "caller didn't pass one" (older test invocations,
# out-of-tree callers); safe_rm_worktree falls back to the
# pre-Pass-2A cache-segment-glob check in that case.
EXPECTED_CACHE_ROOT="${11:-}"
# Treat empty string as "use fallback", not "literal empty branch name".
if [ -z "$DEFAULT_BRANCH" ]; then
  DEFAULT_BRANCH="main"
fi
if [ -z "$MAX_DURATION_SECS" ]; then
  MAX_DURATION_SECS="$DEFAULT_MAX_DURATION_SECS"
fi
# parentCwd (arg 9) is required since POST-R6-CACHE: pi spawns at
# parentCwd to keep the system prompt's `Current working directory:`
# line byte-identical to the parent's, preserving prompt-cache hits.
# Falling back silently to $WORKTREE (pre-R7) re-introduces the cache
# regression with no observable signal — hard-fail instead so any
# out-of-tree caller surfaces the contract violation immediately.
# (R7-PERF-7, R7-CI-6.)
if [ -z "$PARENT_CWD" ]; then
  echo "distill-wrapper: missing required argument 9 (parentCwd) — cache-preserving spawn requires the parent pi session's cwd" >&2
  exit 2
fi

if [ -z "$VAULT" ] || [ -z "$WORKTREE" ] || [ -z "$BRANCH" ] || \
   [ -z "$SESSION_FORK" ] || [ -z "$PROMPT" ] || [ -z "$ERROR_DIR" ]; then
  echo "distill-wrapper: missing required argument" >&2
  exit 2
fi

# Validate maxDurationSecs is a positive integer. timeout(1) accepts
# decimal seconds and unit suffixes (`30s`, `5m`, `1h`); we restrict
# to integer seconds for predictability and to surface contract drift
# loud and early.
case "$MAX_DURATION_SECS" in
  ''|*[!0-9]*)
    echo "distill-wrapper: maxDurationSecs (arg 10) must be a positive integer (got '$MAX_DURATION_SECS')" >&2
    exit 2
    ;;
esac
if [ "$MAX_DURATION_SECS" -le 0 ]; then
  echo "distill-wrapper: maxDurationSecs (arg 10) must be > 0 (got '$MAX_DURATION_SECS')" >&2
  exit 2
fi

# Export so any subprocess (the agent's bash tool, downstream pi
# subprocesses) inherits the error dir for forensic logging.
export NAPKIN_DISTILL_ERROR_DIR="$ERROR_DIR"

# Defense-in-depth for CLEAN-11: the agent's `git -C {{worktreePath}}
# merge --no-edit {{defaultBranch}}` step would, without `--no-edit`,
# open `core.editor` on a clean auto-merge — the agent's bash tool
# has no TTY, so the editor would hang or fail. The prompt now passes
# `--no-edit`, but a future prompt revision (or an agent that crafts
# a `git pull` / `git revert` / `git commit -a` of its own) could
# still trip the same trap. `GIT_TERMINAL_PROMPT=0` makes git fail
# fast on credential prompts (push to a private origin without
# cached creds, etc.) instead of waiting for tty input. `GIT_EDITOR=true`
# substitutes a no-op for any editor invocation — git proceeds with
# whatever default message it composed instead of blocking on user
# input. Both apply to the wrapper, the agent's pi process, and any
# git subprocess launched from the agent's bash tool.
export GIT_TERMINAL_PROMPT=0
export GIT_EDITOR=true

# Compute error log path. `branch-short-hash` is the portion after `distill/`
# (already unique per invocation — hex nonce + epoch).
BRANCH_SHORT="${BRANCH#distill/}"
TIMESTAMP="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
# Single fatal-error log per branch. PR #12 removes the partial-merge
# log entirely (no driver to 3-strike). The presence of *.log is the
# JS-side signal that the wrapper failed (R7-SC-3 + R8-CC-1). Lazily
# created on first `log_error` call.
ERROR_LOG="$ERROR_DIR/${TIMESTAMP}-$$-${BRANCH_SHORT}.log"
# Outcome sidecar (POST-CONV-5) — one-line classification of why the
# wrapper exited 0. The detached wrapper's exit status is unobservable
# to the parent (`stdio:ignore` + `unref()`); the filesystem is the
# only signal channel.
#
# JS-side runDistillWith poller dispatches UI severity per outcome class.
# See formatOutcomeNotification in extensions/distill/index.ts for the
# canonical mapping. Per the locked notification severity contract:
# merged-content → info; no-content → warning; merged-local → warning;
# failed:<reason> → error.
OUTCOME_PATH="$ERROR_DIR/${TIMESTAMP}-$$-${BRANCH_SHORT}.outcome"

# Lazy-create error log on first write. Empty file is the "no error" signal.
ERROR_LOG_TOUCHED=0
log_error() {
  if [ "$ERROR_LOG_TOUCHED" -eq 0 ]; then
    mkdir -p "$ERROR_DIR"
    {
      echo "# napkin distill error log"
      echo "branch: $BRANCH"
      echo "vault: $VAULT"
      echo "worktree: $WORKTREE"
      echo "started: $TIMESTAMP"
      echo "pid: $$"
      echo
    } >> "$ERROR_LOG"
    ERROR_LOG_TOUCHED=1
  fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $*" >> "$ERROR_LOG"
}

# Capture the dangling commit SHA for forensic recovery (git gc grace period
# is 2 weeks by default; `git reflog` holds 90 days). Printed into the error
# log on any fatal failure path so the user can `git cat-file -p <sha>` to
# resurrect the distill's work.
record_dangling_sha() {
  local sha
  sha="$(git -C "$WORKTREE" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$sha" ]; then
    log_error "dangling distill commit SHA: $sha"
  fi
}

# Write the outcome sidecar (POST-CONV-5). The first line is the
# outcome class (one-token, machine-readable); subsequent lines
# (optional) are a human-readable recovery hint.
#
# Caller must invoke this immediately before any successful `exit 0`
# OR `exit 1` path. Idempotent: a double call rewrites the same file.
#
# JS-side parser (`findDistillOutcomeForBranch`) reads the first line
# as the outcome class for severity dispatch and exposes the remaining
# lines as a `recoveryHint?: string` for inclusion in the failure
# notification.
#
# Recovery hint is OPTIONAL because the happy-path classes
# (`merged-content`, `merged-local`, `no-content`) need no recovery
# action — only the `failed:<reason>` classes do.
#
# Atomicity (SEC-A-4): write to `<sidecar>.tmp` then `mv` to the final
# path. POSIX `rename(2)` is atomic on the same filesystem, so the
# JS-side poller (`findDistillOutcomeForBranch`) either sees the file
# absent or sees the complete contents — never a partial write where
# line 1 is present but line 2 (recovery hint) hasn't landed yet.
# Without this guard, the multi-line write path (two `printf`s into
# the same redirect) could race a poller that opens between the
# kernel's write of line 1 and line 2 and misclassify a failed
# distill as having no recovery hint.
write_outcome() {
  local class="$1"
  local recovery_hint="${2:-}"
  mkdir -p "$ERROR_DIR" 2>/dev/null || true
  local tmp="$OUTCOME_PATH.tmp"
  if [ -n "$recovery_hint" ]; then
    printf '%s\n%s\n' "$class" "$recovery_hint" > "$tmp" 2>/dev/null || {
      rm -f "$tmp" 2>/dev/null || true
      return 0
    }
  else
    printf '%s\n' "$class" > "$tmp" 2>/dev/null || {
      rm -f "$tmp" 2>/dev/null || true
      return 0
    }
  fi
  mv "$tmp" "$OUTCOME_PATH" 2>/dev/null || {
    rm -f "$tmp" 2>/dev/null || true
    return 0
  }
}

# safe_rm_worktree <worktree_path> [<expected_cache_root>]
#
# Defense-in-depth path-safety guard before `rm -rf <worktree>`. The
# wrapper's primary defense is JS-side construction: `resolveCacheRoot`
# in distill-workspace.ts always builds worktrees under
# `<XDG_CACHE_HOME or ~/.cache>/napkin-distill/<vault-hash>/<branch-suffix>/`,
# and `git worktree remove --force <path>` refuses paths not registered
# as worktrees of the vault. But if either control failed (upstream
# refactor bug, malformed test fixture, future code path that passes
# a different path through), the bare `rm -rf "$worktree"` after
# `worktree remove` would run on whatever path was passed in —
# `rm -rf /etc` if the upstream was that broken (SEC-A-2).
#
# This guard adds the wrapper-side check.
#
# Two acceptance modes:
#   1. STRICT (preferred, SEC-2 / CORR-3): when `<expected_cache_root>`
#      is supplied (the JS-side now passes `resolveCacheRoot(vault)`
#      as the 11th positional arg of the wrapper), the worktree's
#      canonical path must be a descendant of that exact cache root.
#      A bug elsewhere that constructed a path like
#      `/some/random/dir/napkin-distill/foo/bar` cannot bypass this
#      check — even though it contains the napkin-distill segment,
#      it isn't under the resolved root.
#   2. LEGACY (fallback): when `<expected_cache_root>` is empty
#      (older test invocations or out-of-tree callers on the 10-arg
#      shape), fall back to the pre-Pass-2A cache-segment glob
#      `*/napkin-distill/*/*`. This preserves backward compatibility
#      while allowing new callers to opt into the strict check.
#
# `pwd -P` resolves symlinks (and is portable across BSD/GNU,
# unlike `readlink -f` which is GNU-only).
#
# Returns 0 on successful removal (or already-removed). Returns 1
# when the path didn't pass the safety guard — caller must log and
# proceed, never abort: salvage's contract is best-effort cleanup,
# and the outcome-write path matters more than perfectly cleaning up
# a malformed worktree path.
safe_rm_worktree() {
  local worktree="$1"
  local expected_cache_root="${2:-}"
  if [ -z "$worktree" ]; then
    log_error "safe_rm_worktree: empty worktree path; refusing to rm-rf"
    return 1
  fi
  if [ ! -d "$worktree" ]; then
    # Already gone — nothing to do.
    return 0
  fi
  # Canonicalise to defeat symlink/relative-path tricks. `pwd -P`
  # yields the absolute physical path of the cwd; cd'ing into the
  # worktree first means we get its physical path even if the input
  # was a symlink.
  local resolved
  resolved="$(cd "$worktree" 2>/dev/null && pwd -P)" || resolved=""
  if [ -z "$resolved" ]; then
    log_error "safe_rm_worktree: could not resolve canonical path for '$worktree'; refusing to rm-rf"
    return 1
  fi
  if [ -n "$expected_cache_root" ]; then
    # STRICT mode (SEC-2 / CORR-3): require descendant-of-cache-root.
    # Resolve the cache root canonically too — if it's a symlink the
    # JS side might have given us the symlink's target via
    # `fs.realpathSync`, but defending against the case where it
    # didn't is cheap and removes a footgun.
    local resolved_root
    if [ -d "$expected_cache_root" ]; then
      resolved_root="$(cd "$expected_cache_root" 2>/dev/null && pwd -P)" || resolved_root=""
    else
      # Cache root may not exist yet (e.g. test scaffold that built
      # the worktree but never instantiated the parent vault-hash
      # dir). Fall back to the literal value — the prefix match
      # below still works on logically-equivalent absolute paths.
      resolved_root="$expected_cache_root"
    fi
    if [ -z "$resolved_root" ]; then
      log_error "safe_rm_worktree: could not resolve canonical path for cache root '$expected_cache_root'; refusing to rm-rf '$worktree'"
      return 1
    fi
    # Require `$resolved` to start with `$resolved_root/`. Trailing
    # slash on the prefix prevents a sibling-directory false-accept
    # like `/cache/napkin-distill/abc` matching `/cache/napkin-distill/abc-evil`.
    case "$resolved" in
      "$resolved_root"/*)
        rm -rf "$resolved" 2>/dev/null || true
        return 0
        ;;
      *)
        log_error "safe_rm_worktree: refusing to rm-rf '$resolved' (resolved from '$worktree') — not a descendant of expected cache root '$resolved_root'"
        return 1
        ;;
    esac
  fi
  # LEGACY mode (no expected_cache_root): fall back to the glob check
  # (pre-Pass-2A behaviour). Refuse anything outside the napkin-distill
  # cache layout. The match is on the absolute resolved path, so a
  # symlink that points at /etc would resolve to /etc here and miss
  # the pattern.
  case "$resolved" in
    */napkin-distill/*/*)
      rm -rf "$resolved" 2>/dev/null || true
      return 0
      ;;
    *)
      log_error "safe_rm_worktree: refusing to rm-rf '$resolved' (resolved from '$worktree') — not under a 'napkin-distill/<hash>/' subtree"
      return 1
      ;;
  esac
}

# salvage <vault> <worktree_path> <branch_name> <reason>
#
# Force-cleans the per-distill worktree and branch, validates the
# vault is back on its default branch, and writes a `failed:<reason>`
# outcome sidecar with a recovery hint. Per V3 verification
# (research/v2-v3-verification.md) the salvage path NEVER touches the
# main vault's commit history — the agent's mutations on main are
# trusted, and `git reset --hard $START_SHA` would silently destroy
# concurrent user commits in the autosave-while-editing scenario.
#
# Reason codes (must match the JS-side dispatch table):
#   markers-after-agent-exit
#   head-not-on-default
#   agent-exit-nonzero
#   agent-timeout
#   divergent-history
#
# Cleanup operations are best-effort: a failed `worktree remove` or
# `branch -D` does NOT prevent the outcome write — the JS-side
# UI dispatch on the outcome class is the user-facing signal that
# matters.
salvage() {
  local vault="$1"
  local worktree="$2"
  local branch="$3"
  local reason="$4"

  # cd out of the worktree so `git worktree remove --force` doesn't
  # refuse on "cwd inside worktree".
  cd "$vault" 2>/dev/null || cd /

  # Force-remove worktree. Ignore errors (already gone, never created,
  # other concurrent salvage racing).
  if [ -d "$worktree" ]; then
    git -C "$vault" worktree remove --force "$worktree" 2>/dev/null || true
  fi
  # Belt-and-braces: gitignored shim survives `worktree remove --force`.
  # rm -rf the leaf if anything's left (POST-CONV-3 pattern). Routed
  # through safe_rm_worktree so an upstream bug that passed a non-
  # napkin-distill path can't escalate to `rm -rf /etc`-class damage
  # via this code path (SEC-A-2 defense-in-depth). Pass
  # EXPECTED_CACHE_ROOT so safe_rm_worktree's strict-mode descendant
  # check fires (SEC-2 / CORR-3) instead of the legacy glob fallback.
  if [ -d "$worktree" ]; then
    safe_rm_worktree "$worktree" "$EXPECTED_CACHE_ROOT" || true
  fi
  # Prune any stale worktree entry whose dir is gone.
  git -C "$vault" worktree prune 2>/dev/null || true
  # Force-delete branch. -D because squash-merge leaves the branch
  # marked as unmerged.
  git -C "$vault" branch -D "$branch" 2>/dev/null || true
  # Best-effort rmdir of the parent vault-hash dir — succeeds when
  # this was the last distill (POST-CONV-4 pattern).
  rmdir "$(dirname "$worktree")" 2>/dev/null || true

  # Verify HEAD is on default. Per V3, the salvage path NEVER moves
  # HEAD on the user's behalf — if the user manually checked out a
  # different branch mid-distill, that's their state, not ours to
  # rewrite. Log a critical-error so it surfaces in the failure
  # notification, but don't `git checkout`.
  local vault_head
  vault_head="$(git -C "$vault" symbolic-ref --short HEAD 2>/dev/null || true)"
  if [ -z "$vault_head" ]; then
    log_error "salvage: vault HEAD is detached after agent exit; user must checkout '$DEFAULT_BRANCH' manually before next distill"
  elif [ "$vault_head" != "$DEFAULT_BRANCH" ]; then
    log_error "salvage: vault HEAD is '$vault_head' after agent exit (expected '$DEFAULT_BRANCH'); not rewriting per never-touch-main lockdown"
  fi

  # Compose recovery hint per reason. Each hint points the user at the
  # specific recovery action that fits the failure mode — the design
  # spec calls out `git revert HEAD --no-edit` and `git reflog` as the
  # primary recovery levers ("the dangling distill branch is
  # recoverable from `git reflog` for ~2 weeks").
  local hint
  case "$reason" in
    markers-after-agent-exit)
      hint="Conflict markers landed in the vault. Inspect '$vault', then 'git -C $vault revert HEAD --no-edit' to undo the corrupt commit. Distill content is recoverable from 'git -C $vault reflog' for ~90 days."
      ;;
    head-not-on-default)
      hint="Vault HEAD is not on '$DEFAULT_BRANCH'. Run 'git -C $vault checkout $DEFAULT_BRANCH' before the next distill. Distill content is recoverable from 'git -C $vault reflog'."
      ;;
    agent-exit-nonzero)
      hint="Agent crashed before completing the distill. See the error log alongside this outcome for stderr. Distill content (if any) is recoverable from 'git -C $vault reflog'."
      ;;
    agent-timeout)
      hint="Agent task exceeded the maxDurationMinutes budget and was killed. Bump 'distill.maxDurationMinutes' in vault config.json if this happens repeatedly. Distill content (if any) is recoverable from 'git -C $vault reflog'."
      ;;
    divergent-history)
      hint="origin/$DEFAULT_BRANCH and local $DEFAULT_BRANCH have diverged — typically because someone (you or a teammate) pushed to origin from another clone before this distill ran. Less commonly, someone force-pushed there. Inspect with 'git -C $vault log origin/$DEFAULT_BRANCH..$DEFAULT_BRANCH' (your local commits not on origin) and 'git -C $vault log $DEFAULT_BRANCH..origin/$DEFAULT_BRANCH' (origin commits not local), then resolve by pulling-and-merging or by inspecting the divergence and choosing the right recovery (revert, manual merge, etc.). Distill content is recoverable from 'git -C $vault reflog' for ~90 days."
      ;;
    *)
      hint="Distill failed with an unrecognised reason. See the error log for diagnostics. Distill content (if any) is recoverable from 'git -C $vault reflog'."
      ;;
  esac

  write_outcome "failed:$reason" "$hint"
}


# --- Post-agent-exit validation helpers (PR #12 A3) -------------------------
#
# Each helper inspects the vault's post-agent state and returns 0 (pass) or
# 1 (fail). Diagnostics go to the error log on failure so the user can see
# what tripped the validator. Helpers are intentionally side-effect-free
# beyond logging — the salvage path (A4) is the only thing that mutates
# the worktree/branch on validation failure.

# validate_no_markers <vault>
#
# Searches the vault's tracked `*.md` files for unresolved git conflict
# markers. Returns 0 (pass) when no file contains a complete marker
# triple, 1 (fail) when any file does.
#
# Marker triple definition (CORR-A-1, SEC-A-7): a real merge conflict
# always emits ALL THREE marker types (`<<<<<<< `, `======= `, `>>>>>>> `)
# in the same file. Tightening the validator to require co-presence
# eliminates two known false-positive classes that the prior
# any-of-three regex tripped on:
#   - Setext H1 underlines: a heading like `# title\n=======` lights
#     up the `=======$` rule but is not a conflict.
#   - Documentation prose: notes / READMEs / spec files that quote a
#     conflict marker in a code block to discuss conflicts (the user's
#     own vault might contain `<<<<<<< HEAD` in prose). The prior
#     validator would permanently block distills on such vaults.
# A real merge conflict always lands all three; a documentation note
# that wants to render only one or two markers is fine.
#
# Acknowledged tradeoff: a vault that genuinely documents a complete
# `<<<<<<<` / `=======` / `>>>>>>>` example INSIDE A SINGLE FILE will
# now trip the validator. Users who hit this can escape the markers
# in their docs (e.g. ` <<<<<<<` with a leading space, or use HTML
# comments around the example). The false-positive cost of the prior
# permissive check (block-all-distills-forever on legitimate
# documentation) is much higher than the rare-explicit-doc case.
#
# Why scan post-squash on the vault: the agent merges into its branch
# inside the worktree, then squashes onto the default branch in the
# vault. Markers in the agent's branch get squashed into the vault's
# default branch — they become committed corruption in the vault. The
# vault working tree is the canonical post-condition.
#
# Restricted to `*.md` because that's the only file class the agent
# touches; scanning the entire vault would false-positive on user
# scripts that legitimately discuss markers.
#
# We use a `git ls-files` enumeration (so .gitignore'd content like
# `.napkin/distill/` is skipped automatically) intersected with `*.md`.
# Per-file `grep -q` invocations are O(N) where N is the number of
# tracked .md files; the prior single-pass `xargs grep` was O(1) but
# couldn't express the per-file all-three-co-present predicate. For
# vaults with thousands of .md files this is slower but still well
# under wall-clock budget. CLEAN-A-15 tracks the optimisation
# opportunity.
#
# bash 3.2 portability (macOS default): `while read -d ''` with array
# `+=` is supported. Process substitution `< <(...)` is also bash 3.2.
validate_no_markers() {
  local vault="$1"
  local conflicted_files=()
  local file
  while IFS= read -r -d '' file; do
    # All three markers must appear in the same file. `grep -q`
    # short-circuits on first match, and the `&&` chain stops as
    # soon as one marker type is absent — minimising work in the
    # common no-conflict case.
    if grep -qE '^<{7} ' -- "$vault/$file" 2>/dev/null \
       && grep -qE '^={7}$' -- "$vault/$file" 2>/dev/null \
       && grep -qE '^>{7} ' -- "$vault/$file" 2>/dev/null; then
      conflicted_files+=("$vault/$file")
    fi
  done < <(git -C "$vault" ls-files -z -- '*.md' 2>/dev/null)
  if [ ${#conflicted_files[@]} -gt 0 ]; then
    log_error "validate_no_markers: residual conflict markers found in vault \`$vault\`:"
    for file in "${conflicted_files[@]}"; do
      log_error "  $file"
    done
    return 1
  fi
  return 0
}

# validate_head_on_default <vault> <default_branch>
#
# Confirms the vault's HEAD is the symbolic ref `refs/heads/<default>`.
# Per V3 verification (research/v2-v3-verification.md), use
# `git symbolic-ref --short HEAD` — it returns the short branch name on
# a normal checkout and exits non-zero on detached HEAD. The other two
# options (`branch --show-current` returns empty on detached;
# `rev-parse --abbrev-ref HEAD` returns literal `HEAD` on detached)
# silently false-positive.
#
# Returns 0 (pass) when HEAD == default. Returns 1 (fail) on any other
# state, including detached HEAD. Refusing to act on detached HEAD is
# correct: the agent should have exited with HEAD on default after
# step 8, and the wrapper must not silently accept a vault in the
# wrong state.
validate_head_on_default() {
  local vault="$1"
  local default="$2"
  local head
  head="$(git -C "$vault" symbolic-ref --short HEAD 2>/dev/null || true)"
  if [ -z "$head" ]; then
    log_error "validate_head_on_default: vault HEAD is detached (not on a branch); expected '$default'"
    return 1
  fi
  if [ "$head" != "$default" ]; then
    log_error "validate_head_on_default: vault HEAD is '$head', expected '$default'"
    return 1
  fi
  return 0
}

# validate_commit_count <vault> <start_sha>
#
# Prints (to stdout) the number of commits on the vault's current HEAD
# since `<start_sha>` (exclusive). Returns 0 unless the rev-list call
# itself fails (which would be a hard error — startSha must be reachable
# from HEAD or the wrapper's invariants are broken).
#
# Used by the wrapper to dispatch among:
#   - 0 commits   -> no-content (agent ran but produced nothing)
#   - 1+ commits  -> merged-content / merged-local (agent landed work)
#
# This is intentionally a count, not a boolean: future telemetry
# (POST-CONV-7-TELEM) wants the number for outcome distribution
# analysis. The wrapper's own dispatch only needs `>= 1`.
#
# Rev-list semantics: `<start_sha>..HEAD` includes commits reachable
# from HEAD that are NOT reachable from start_sha. If main moved since
# distill spawn (concurrent user commit + agent's squash), both are
# counted — acceptable looseness for the no-content vs has-content
# dispatch (we err on the side of "has content").
validate_commit_count() {
  local vault="$1"
  local start_sha="$2"
  local count
  count="$(git -C "$vault" rev-list --count "$start_sha..HEAD" 2>/dev/null || true)"
  if [ -z "$count" ]; then
    log_error "validate_commit_count: git rev-list failed for $start_sha..HEAD in $vault"
    return 1
  fi
  printf '%s\n' "$count"
  return 0
}

# detect_local_only <vault> <default_branch>
#
# Determines whether the vault has commits on `<default_branch>` that
# haven't reached `origin/<default_branch>`. Distinguishes legitimate
# fast-forward state (local ahead of remote, remote is ancestor of
# local — the agent didn't push but origin's history is intact) from
# divergent state (remote is NOT an ancestor of local — origin and
# local share no linear ancestry, e.g. because a teammate pushed from
# another clone or, less commonly, someone force-pushed origin).
#
# Per the spec at "Push behavior: never force":
#   "Spec the prohibition in the prompt; the wrapper post-validates by
#    checking that origin/<default> only fast-forwarded (its tip is an
#    ancestor of the new tip after push)."
#
# Equality-check (the pre-fix behavior) couldn't tell those two states
# apart — in either case local != remote post-agent. The prompt's
# prohibition was the only enforcement of the no-force-push invariant
# (a soft control). This helper now adds the wrapper-side hard control
# the spec requires (SEC-A-1).
#
# Return codes:
#   0 — local-only (`merged-local` outcome): origin configured AND
#       (no remote-tracking ref yet OR remote is ancestor of local).
#       Either case is legitimate “distilled but not pushed” state.
#   1 — in sync OR no origin configured: proceed to `merged-content`.
#   2 — divergent histories (`failed:divergent-history` outcome):
#       remote is NOT an ancestor of local. The wrapper surfaces this
#       as a failure because the agent's safe-recovery flow
#       (pull --no-rebase + push) did not run or did not converge,
#       and the user must inspect/resolve before the next distill.
#       The naming is neutral on cause: a benign third-party push
#       from another clone is the common case, force-push the rare
#       one (and SEC-1/CORR-2 round-2 review elevated this to a
#       cross-reviewer-consensus rename from `force-push-detected`).
detect_local_only() {
  local vault="$1"
  local default="$2"
  # No origin configured at all → push was never expected; not local-only.
  if ! git -C "$vault" remote get-url origin >/dev/null 2>&1; then
    return 1
  fi
  local local_sha remote_sha
  local_sha="$(git -C "$vault" rev-parse "$default" 2>/dev/null || true)"
  remote_sha="$(git -C "$vault" rev-parse "origin/$default" 2>/dev/null || true)"
  # Origin configured but no remote-tracking ref yet (e.g. never fetched)
  # → treat as local-only because origin is the user's intent and the
  # agent's push didn't materialise.
  if [ -z "$remote_sha" ]; then
    log_error "detect_local_only: origin configured but origin/$default unreachable; treating as merged-local"
    return 0
  fi
  if [ -z "$local_sha" ]; then
    # Default branch doesn't exist locally — unexpected; surface as
    # not-local-only and let the markers / commit-count validators
    # decide the outcome.
    return 1
  fi
  if [ "$local_sha" = "$remote_sha" ]; then
    # In sync — push happened (or nothing changed). Not local-only.
    return 1
  fi
  # Local differs from remote. Ancestry decides whether the divergence
  # is legitimate (fast-forward pending) or non-linear (`divergent-history`).
  if git -C "$vault" merge-base --is-ancestor "$remote_sha" "$local_sha"; then
    # Remote is ancestor of local — fast-forward pending. Either the
    # agent didn't push, or the push failed and the agent fell back
    # to local-only. Legitimate `merged-local`.
    return 0
  fi
  # Remote is NOT an ancestor of local — origin and local share no
  # linear ancestry. The common case is a teammate (or the user from
  # another clone) pushing to origin while this distill ran; the rare
  # case is a force-push that rewrote origin's history. Either way
  # the agent's safe-recovery path (pull --no-rebase + push) did not
  # converge, so the wrapper surfaces a `divergent-history` failure
  # for the user to inspect and resolve.
  log_error "detect_local_only: origin/$default at $remote_sha is not an ancestor of local $default at $local_sha (divergent histories)"
  return 2
}


# Trap-based cleanup: always remove the worktree + branch on exit (success or
# failure). `git worktree remove --force` also handles partially-initialized
# worktrees. Errors from cleanup are logged but don't affect our exit status.
#
# PR #12 cleanup is unchanged from PR #11: agent SHOULD do its own cleanup
# in step 10 of the prompt, but the wrapper's trap is the safety net for
# any path the agent didn't reach (timeout, crash, error, salvage). Idempotent
# against the agent having already removed the worktree (`git worktree
# remove` errors on a missing path; we discard the error).
cleanup() {
  local rc=$?
  # cd out of the worktree before removing it, otherwise git refuses.
  cd "$VAULT" 2>/dev/null || cd /
  if [ -d "$WORKTREE" ]; then
    git -C "$VAULT" worktree remove --force "$WORKTREE" 2>/dev/null || true
  fi
  # In production this fires on every exit because the gitignored
  # .napkin/distill/ shim survives `git worktree remove --force`. The
  # `[ -d ]` guard is defensive against future scenarios where the shim
  # is removed before this point. Mirrors cleanupDistillWorkspace's
  # contract at distill-workspace.ts:572. Routed through
  # safe_rm_worktree so an upstream bug that passed a non-napkin-distill
  # path can't escalate to `rm -rf /etc`-class damage via this code
  # path (SEC-A-2 defense-in-depth). Pass EXPECTED_CACHE_ROOT so
  # safe_rm_worktree's strict-mode descendant check fires
  # (SEC-2 / CORR-3) instead of the legacy glob fallback.
  if [ -d "$WORKTREE" ]; then
    safe_rm_worktree "$WORKTREE" "$EXPECTED_CACHE_ROOT" || true
  fi
  # Prune in case the worktree entry is stale but the dir is gone.
  git -C "$VAULT" worktree prune 2>/dev/null || true
  # -D (force) because the distill branch is never marked "merged" (we use
  # squash merge on main, which leaves the branch dangling).
  git -C "$VAULT" branch -D "$BRANCH" 2>/dev/null || true
  # Best-effort rmdir of the parent vault-hash dir — succeeds when this
  # was the last distill for the vault. ENOTEMPTY (other concurrent
  # distills) and ENOENT (race) are both expected and benign.
  rmdir "$(dirname "$WORKTREE")" 2>/dev/null || true
  exit "$rc"
}
trap cleanup EXIT

# --- Update meta.json's pid to OUR pid ($$) -----------------------------------
#
# createDistillWorkspace() writes meta.json before this wrapper starts, with
# `pid` set to the parent pi session's pid — a pre-spawn placeholder. For
# liveness checks in `getActiveDistills` / `cleanupStaleWorktrees` to be
# accurate, the recorded pid must track THIS wrapper's lifetime: when this
# process dies, the worktree is defunct; when it runs, the worktree is live.
# Rewrite the pid field in place before doing anything else.
#
# The JSON is produced by node's JSON.stringify(obj, null, 2), so the `pid`
# line always has the shape `  "pid": <number>,`. A targeted sed replaces
# just that line. We use a temp file + mv for atomicity (cheap since it's
# same-filesystem).
META_PATH="$WORKTREE/.napkin/distill/meta.json"
if [ -f "$META_PATH" ]; then
  META_TMP="$META_PATH.tmp.$$"
  if sed -E "s/(\"pid\":[[:space:]]*)[0-9]+/\1$$/" "$META_PATH" > "$META_TMP"; then
    mv "$META_TMP" "$META_PATH"
  else
    rm -f "$META_TMP"
    log_error "failed to rewrite meta.json pid to wrapper pid ($$)"
  fi
fi

# Extract startSha from meta.json — used by record_dangling_sha and
# (in A3) by validate_commit_count to confirm the agent landed at
# least one commit beyond pre-distill HEAD.
#
# Use node for parsing instead of sed: a regex on JSON is fragile
# against future shape changes (multi-line values, embedded commas,
# nested objects) and would silently degrade to an empty extraction
# on shape drift. Node is normally on PATH inside the wrapper because
# pi-bun spawned us; the same JSON parser the JS side wrote with is
# the most robust reader.
#
# Hard-fail with a clear diagnostic if node is missing or unrunnable
# rather than letting the meta-missing-startSha hard-fail downstream
# mislead the user (R13-CI-1 / R13-CC-3).
REAL_NODE="$(command -v node || true)"
if [ -z "$REAL_NODE" ]; then
  log_error "node binary not found on wrapper PATH; required for startSha extraction. Set PATH to include node before launching pi."
  log_error "  PATH=$PATH"
  exit 1
fi
if ! "$REAL_NODE" --version >/dev/null 2>&1; then
  log_error "node binary not runnable on wrapper PATH (resolved to '$REAL_NODE'); shebang or binary issue."
  log_error "  PATH=$PATH"
  exit 1
fi

START_SHA=""
if [ -f "$META_PATH" ]; then
  START_SHA="$("$REAL_NODE" -e 'try { const d = require(process.argv[1]); process.stdout.write(d.startSha || ""); } catch { /* swallow — empty START_SHA triggers the hard-fail below */ }' "$META_PATH" 2>/dev/null || true)"
fi

# Hard-fail when startSha can't be recovered (consistent with PR #11).
if [ -z "$START_SHA" ]; then
  log_error "meta.json missing startSha; refusing to proceed (worktree from incompatible pi-napkin version?)"
  exit 1
fi

# Testing hook: halt right after the meta-pid rewrite so integration tests
# can inspect the updated meta.json before the cleanup trap removes the
# worktree. Clears the EXIT trap so cleanup is skipped.
if [ "${NAPKIN_DISTILL_HALT_AFTER_META:-}" = "1" ]; then
  trap - EXIT
  exit 0
fi

# --- Install per-distill napkin shim that auto-routes to the worktree -------
#
# Pi runs at PARENT_CWD (not the worktree) to keep the system prompt's
# `Current working directory:` line byte-identical to the parent's,
# preserving prompt-cache hits across the spawn boundary. That means
# napkin's cwd-based vault walk-up resolves to the *parent's* vault
# (typically the same one we want, but the writes need to land in the
# worktree's checkout for the subsequent merge/squash/push to see them).
#
# The shim transparently injects `--vault $WORKTREE` into every napkin
# invocation from the agent's bash tool. The real napkin path is
# resolved here (via `command -v`) and baked in as an absolute path —
# so the shim, once invoked, doesn't depend on PATH lookup. PATH
# ordering is still required to ensure the agent's shell resolves
# `napkin` to THIS shim and not the global one: that's what the
# `export PATH="$SHIM_DIR:$PATH"` further down handles.
#
# Lives at `<worktree>/.napkin/distill/bin/napkin` so it's removed when
# the worktree is removed (no extra cleanup needed). The directory is
# already `.gitignore`d via the `.napkin/distill/` exclusion.
#
# CI / test note: when NAPKIN_DISTILL_SKIP_PI=1 the shim is skipped
# (no agent run → no napkin invocations to route). Lets the integration
# tests run in environments where napkin isn't installed (e.g. fresh
# CI runners). Production never sets SKIP_PI.
#
# See POST-R6-CACHE in features/pi-napkin-distill/deferred.md for the
# full design rationale.
if [ "${NAPKIN_DISTILL_SKIP_PI:-}" != "1" ]; then
  SHIM_DIR="$WORKTREE/.napkin/distill/bin"
  REAL_NAPKIN="$(command -v napkin || true)"
  if [ -z "$REAL_NAPKIN" ]; then
    # Include $PATH in the error log so the user can diagnose missing
    # PATH entries (e.g. cron / systemd / launchd-launched pi with a
    # stripped PATH) without further trial. The error log is vault-local
    # and never leaves the user's machine.
    log_error "napkin binary not found on wrapper PATH; cache-preserving shim cannot be installed"
    log_error "  PATH=$PATH"
    exit 1
  fi
  # Refuse to install on top of another distill shim (recursion footgun:
  # an inherited PATH from an aborted run could leave a stale shim ahead
  # of the real napkin, and the new shim would exec the OLD shim, which
  # exec's the real napkin with a stale --vault — multi-hop indirection
  # at every napkin call). The pattern matches our own shim path layout.
  case "$REAL_NAPKIN" in
    */.napkin/distill/bin/napkin)
      log_error "refusing to install shim — \`command -v napkin\` resolved to another distill shim ($REAL_NAPKIN); check PATH for a stale .napkin/distill/bin/ entry"
      log_error "  PATH=$PATH"
      exit 1
      ;;
  esac
  # Smoke-test that the resolved napkin actually executes. `command -v`
  # only verifies PATH resolution; bun installs napkin as a symlink to
  # `dist/main.js` with `#!/usr/bin/env node` shebang, which fails at
  # exec time if `node` isn't on PATH. Catching that here surfaces a
  # clean diagnostic instead of cryptic "node: not found" on every
  # agent napkin call.
  if ! "$REAL_NAPKIN" --version >/dev/null 2>&1; then
    log_error "napkin not runnable on wrapper PATH (resolved to '$REAL_NAPKIN'); cache-preserving shim cannot be installed"
    log_error "  PATH=$PATH"
    exit 1
  fi
  if ! mkdir -p "$SHIM_DIR"; then
    log_error "failed to mkdir shim dir: $SHIM_DIR"
    exit 1
  fi
  # Generate the shim with `printf %q` so $REAL_NAPKIN and $WORKTREE are
  # shell-escaped at install time. This is escape-safe: any `"`, `\`,
  # `$`, or backtick in either path is quoted so the resulting shim is
  # always well-formed. Plain heredoc-with-interpolation (used
  # previously) was a latent injection surface — see R7-SC-2 / R7-CI-4
  # in features/pi-napkin-distill/pr-11/reviews/.
  if ! {
    printf '#!/usr/bin/env bash\n'
    printf '# Auto-generated distill napkin shim. Routes every napkin command\n'
    printf '# to the distill worktree so vault writes from the agent'\''s bash\n'
    printf '# tool land inside the worktree even though pi'\''s cwd is the\n'
    printf '# parent session'\''s cwd (set that way to preserve prompt-cache\n'
    printf '# hits). Removed when the worktree is removed.\n'
    printf 'exec %q --vault %q "$@"\n' "$REAL_NAPKIN" "$WORKTREE"
  } > "$SHIM_DIR/napkin"; then
    log_error "failed to write shim to $SHIM_DIR/napkin"
    exit 1
  fi
  if ! chmod +x "$SHIM_DIR/napkin"; then
    log_error "failed to chmod +x shim: $SHIM_DIR/napkin"
    exit 1
  fi
  export PATH="$SHIM_DIR:$PATH"
fi

# Testing hook: halt right after the shim install so tests can inspect the
# shim file without the cleanup trap wiping the worktree. Clears the EXIT
# trap so cleanup is skipped — caller is responsible for tearing down the
# worktree afterward.
if [ "${NAPKIN_DISTILL_HALT_AFTER_SHIM:-}" = "1" ]; then
  trap - EXIT
  exit 0
fi

# Testing hook: trigger the cleanup trap from a controlled exit point
# so tests can drive the actual rm-rf fallback (POST-CONV-3) and rmdir
# parent (POST-CONV-4) paths through the wrapper instead of
# reproducing them in inline bash. Unlike HALT_AFTER_META and
# HALT_AFTER_SHIM, this hook does NOT clear the EXIT trap — cleanup
# fires normally and the test asserts on the post-cleanup state.
# Placement is post-shim-install so the worktree has gitignored
# content (.napkin/distill/bin/napkin shim) that survives
# `git worktree remove --force`, exercising the rm-rf fallback.
if [ "${NAPKIN_DISTILL_FORCE_CLEANUP:-}" = "1" ]; then
  log_error "FORCE_CLEANUP hook fired post-shim-install (test hook); triggering cleanup trap"
  exit 1
fi

# --- Step: run the agent under a hard timeout (PR #12 architecture) --------
#
# A single bounded `pi -p` call. The agent's prompt (already resolved by
# `buildDistillPrompt` on the JS side) instructs it to:
#   - distill conversation content into the worktree (steps 1–6)
#   - git merge $DEFAULT_BRANCH into the distill branch from the worktree
#   - git merge --squash $BRANCH onto $DEFAULT_BRANCH from the main vault
#   - git push if origin exists (no force, pull-merge on contention)
#   - git worktree remove + git branch -D
#
# Wrapper guarantees: cwd = PARENT_CWD (cache parity), napkin shim on PATH,
# session is the parent's fork (so the agent has full conversation context),
# `timeout(1)` enforces a hard wall-clock bound, NAPKIN_DISTILL_NO_RECURSE=1
# inhibits the inner pi from auto-distilling.
#
# Agent responsibilities: everything between distill and cleanup. The
# wrapper validates the agent's output post-exit and salvages on
# validation failure (validate_* helpers + salvage() below).

cd "$PARENT_CWD" || { log_error "cd parent cwd failed: $PARENT_CWD"; exit 1; }

# Capture agent exit code so post-validation can dispatch on it. Default
# to 0 when the agent step is skipped (NAPKIN_DISTILL_SKIP_PI=1).
AGENT_RC=0

if [ "${NAPKIN_DISTILL_SKIP_PI:-}" != "1" ]; then
  PI_BIN="${NAPKIN_DISTILL_PI_BIN:-pi}"
  pi_args=(--session "$SESSION_FORK")
  if [ -n "$MODEL" ]; then
    pi_args+=(--model "$MODEL")
  fi
  pi_args+=(-p "$PROMPT")
  # Capture pi's stderr into the error log on non-zero exit. stdout is
  # discarded — the agent's chatter isn't useful forensically; what
  # matters is the post-exit filesystem state.
  pi_stderr="$(mktemp)"
  # `timeout(1) --foreground -k <secs> <budget>` sends SIGTERM at the
  # budget boundary, then escalates to SIGKILL after the grace period
  # (TIMEOUT_KILL_GRACE_SECS) if the target hasn't exited. `--foreground`
  # ensures TTY-attached signals propagate even when invoked without a
  # controlling terminal (which is our case — detached + stdio:ignore).
  #
  # When timeout fires SIGTERM, exit code = 124. SIGKILL escalation
  # exit code = 137. The wrapper distinguishes these from a regular
  # agent crash via case below.
  #
  # TIMEOUT_BIN is detected at wrapper start (resolves to either
  # `timeout` on Linux or `gtimeout` on macOS-with-Homebrew-coreutils).
  NAPKIN_DISTILL_NO_RECURSE=1 \
    "$TIMEOUT_BIN" --foreground -k "$TIMEOUT_KILL_GRACE_SECS" "$MAX_DURATION_SECS" \
      "$PI_BIN" "${pi_args[@]}" > /dev/null 2> "$pi_stderr" || AGENT_RC=$?
  # Write stderr to error log on non-zero exit so post-mortem inspection
  # is possible even when the wrapper went on to write a success
  # outcome (defensive: unexpected stderr on exit-0 is informational).
  if [ "$AGENT_RC" -ne 0 ]; then
    log_error "agent subprocess exited $AGENT_RC; stderr follows:"
    cat "$pi_stderr" >> "$ERROR_LOG" 2>/dev/null || true
  fi
  rm -f "$pi_stderr"
fi

# --- Post-agent-exit dispatch (PR #12 A3) -----------------------------------
#
# Validates the agent's output and writes the appropriate outcome class.
# A3 wires:
#   - validate_no_markers       (markers-after-agent-exit on fail)
#   - validate_head_on_default  (head-not-on-default on fail)
#   - validate_commit_count     (no-content when 0 commits since startSha)
#   - detect_local_only         (merged-local when origin diverges)
#
# Salvage at A3 is minimal: write `failed:<reason>` outcome + record
# dangling SHA + exit 1. The cleanup trap still runs (worktree+branch
# best-effort removal). A4 will replace this with the explicit salvage
# helper that force-cleans pre-exit and emits a recovery hint into the
# outcome sidecar.
#
# Reason codes (from the V3 verification report):
#   markers-after-agent-exit   — V1 fail, conflict markers in vault *.md
#   head-not-on-default        — V2 fail, vault HEAD not on default branch
#   agent-exit-nonzero         — pi exited non-zero with no other diagnostic
#   agent-timeout              — timeout(1) killed the agent (rc 124 or 137)
#   divergent-history          — origin/<default> diverges from local <default>
#                                 (typically a teammate's push from another
#                                 clone; rarely a force-push). Spec at
#                                 "Push behavior: never force" mandates this
#                                 wrapper-side ancestry validation — SEC-A-1)
#
# These four codes match the JS-side dispatch table in
# formatOutcomeNotification (extensions/distill/index.ts).

# `timeout(1)` exit codes per coreutils:
#   124 = timeout fired and target exited within grace period
#   137 = timeout sent SIGKILL after grace period (128 + 9)
# Other non-zero codes are agent crashes proper.
#
# Magic-number rationale (per the methodology guide's never-deferrable
# magic-number rule): 124 and 137 are coreutils-defined exit codes,
# not arbitrary thresholds. Naming them as constants here keeps the
# case statement readable.
TIMEOUT_TERM_RC=124
TIMEOUT_KILL_RC=137

if [ "$AGENT_RC" -eq "$TIMEOUT_TERM_RC" ] || [ "$AGENT_RC" -eq "$TIMEOUT_KILL_RC" ]; then
  log_error "agent task exceeded ${MAX_DURATION_SECS}s budget; SIGTERM/SIGKILL fired (rc $AGENT_RC)"
  record_dangling_sha
  salvage "$VAULT" "$WORKTREE" "$BRANCH" "agent-timeout"
  exit 1
fi

if [ "$AGENT_RC" -ne 0 ]; then
  log_error "agent subprocess exited non-zero (rc $AGENT_RC); see stderr above"
  record_dangling_sha
  salvage "$VAULT" "$WORKTREE" "$BRANCH" "agent-exit-nonzero"
  exit 1
fi

# Agent exit-0 path. Run validators in order: head-on-default first
# (cheap; fails loud on detached HEAD or wrong branch), then markers
# (slightly more expensive scan), then commit count + local-only
# dispatch.
if ! validate_head_on_default "$VAULT" "$DEFAULT_BRANCH"; then
  record_dangling_sha
  salvage "$VAULT" "$WORKTREE" "$BRANCH" "head-not-on-default"
  exit 1
fi

if ! validate_no_markers "$VAULT"; then
  record_dangling_sha
  salvage "$VAULT" "$WORKTREE" "$BRANCH" "markers-after-agent-exit"
  exit 1
fi

VAULT_COMMIT_COUNT="$(validate_commit_count "$VAULT" "$START_SHA" 2>/dev/null || echo "")"
if [ -z "$VAULT_COMMIT_COUNT" ]; then
  log_error "validate_commit_count returned empty; refusing to classify outcome"
  record_dangling_sha
  salvage "$VAULT" "$WORKTREE" "$BRANCH" "agent-exit-nonzero"
  exit 1
fi

if [ "$VAULT_COMMIT_COUNT" -eq 0 ]; then
  # Genuine no-op — agent ran but produced nothing for main. Outcome
  # surfaces as a `warning` notification per the locked notification
  # severity contract.
  write_outcome "no-content"
  exit 0
fi

# Run merged-local / divergent-history detection. detect_local_only returns:
#   0 — local-only (`merged-local` outcome): origin configured AND
#       local is ahead of remote in a fast-forwardable way.
#   1 — in sync OR no origin configured: proceed to `merged-content`.
#   2 — divergent histories (`failed:divergent-history` outcome):
#       remote is NOT an ancestor of local. Either a teammate's push
#       to origin from another clone or, more rarely, a force-push
#       that rewrote origin's history. The agent's safe-recovery
#       path (pull --no-rebase + push) did not converge, so the
#       wrapper surfaces it for user inspection (SEC-A-1: spec at
#       "Push behavior: never force" mandates wrapper-side ancestry
#       validation; SEC-1/CORR-2 round-2 renamed the reason code
#       from `force-push-detected` to neutral-on-cause naming).
#
# Capture rc explicitly because `if detect_local_only … ; then` would
# only branch on rc=0 vs rc!=0, collapsing the rc=1 (in sync) and
# rc=2 (divergent) cases into the same arm.
detect_local_only "$VAULT" "$DEFAULT_BRANCH"
LOCAL_ONLY_RC=$?
if [ "$LOCAL_ONLY_RC" -eq 0 ]; then
  # Origin configured but local main is ahead — agent's push didn't
  # land. Outcome surfaces as `warning` ("distilled but not pushed").
  write_outcome "merged-local"
  exit 0
fi
if [ "$LOCAL_ONLY_RC" -eq 2 ]; then
  log_error "detect_local_only signaled divergent histories (rc 2) — origin/$DEFAULT_BRANCH and local $DEFAULT_BRANCH share no linear ancestry; agent's pull-merge-push recovery did not converge"
  record_dangling_sha
  salvage "$VAULT" "$WORKTREE" "$BRANCH" "divergent-history"
  exit 1
fi

# Happy path: vault HEAD on default, no markers, at least one commit
# since startSha, and either (a) origin is in sync OR (b) origin not
# configured. Surface as `info` ("Distillation complete").
write_outcome "merged-content"
exit 0
