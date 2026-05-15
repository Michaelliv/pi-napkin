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
# A2 transitional state: validation + salvage are stubs in this commit
# (see TODO(A3) and TODO(A4) markers below). A3 wires post-validation;
# A4 wires the salvage path. At A2 the wrapper writes `merged-content`
# on agent-exit-0 unconditionally; that placeholder becomes a proper
# class-detection in A3.
#
# Usage:
#   distill-wrapper.sh <vault> <worktree> <branch> <sessionFork> <prompt> <errorDir> [<model>] [<defaultBranch>] [<parentCwd>] [<maxDurationSecs>]
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
#   4. validate agent output                     (TODO(A3): markers/HEAD/commit-count;
#                                                 stubbed in this A2 commit — assumes
#                                                 success on exit 0)
#   5. salvage if validation fails               (TODO(A4): force-cleanup worktree+
#                                                 branch + write `failed:<reason>`
#                                                 outcome; stubbed in this A2 commit)
#   6. write outcome sidecar                     (`merged-content` placeholder until A3
#                                                 differentiates merged-content vs
#                                                 merged-local; A4 adds `failed:<reason>`)
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

set -uo pipefail

# Resolve our own script dir so we can source git_retry.sh regardless of cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# git_retry.sh is sourced for backward-compat with any out-of-tree
# caller; PR #12's wrapper does not use it directly (the agent owns
# all merge/squash/push retries). Phase B will drop the source line.
# shellcheck source=./git_retry.sh
source "$HERE/git_retry.sh"

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

# Write the outcome sidecar (POST-CONV-5). One line, one class string.
# Caller must invoke this immediately before any successful `exit 0`
# path. Idempotent: a double call would just rewrite the same file.
write_outcome() {
  local class="$1"
  mkdir -p "$ERROR_DIR" 2>/dev/null || true
  printf '%s\n' "$class" > "$OUTCOME_PATH" 2>/dev/null || true
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
  # contract at distill-workspace.ts:572.
  if [ -d "$WORKTREE" ]; then
    rm -rf "$WORKTREE" 2>/dev/null || true
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
# wrapper validates the agent's output post-exit (TODO(A3)) and salvages
# on validation failure (TODO(A4)) — at A2 those are stubs.

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
  # `timeout --foreground` sends SIGTERM (then SIGKILL after a 10s grace)
  # to the entire process group when the budget elapses; `--foreground`
  # ensures TTY-attached signals propagate even when invoked without a
  # controlling terminal (which is our case — detached + stdio:ignore).
  #
  # When timeout fires SIGTERM, exit code = 124. SIGKILL escalation
  # exit code = 137. The wrapper distinguishes these from a regular
  # agent crash via case below.
  NAPKIN_DISTILL_NO_RECURSE=1 \
    timeout --foreground "$MAX_DURATION_SECS" \
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

# --- TODO(A3): post-agent validation ----------------------------------------
#
# A3 wires:
#   - validate_no_markers      — grep -rEln '^(<<<<<<< |======= |>>>>>>> )'
#                                across the vault working tree
#   - validate_head_on_default — git symbolic-ref --short HEAD == $DEFAULT_BRANCH
#   - validate_commit_count    — main has at least one new commit since
#                                $START_SHA
#   - detect_local_only        — when origin exists and local main is ahead
#                                of origin/$DEFAULT_BRANCH, classify as
#                                `merged-local` instead of `merged-content`
#
# At A2 the wrapper writes `merged-content` unconditionally on agent
# exit 0; on agent non-zero exit, no outcome is written (the
# absent-sidecar JS-side path surfaces a warning). A4 will overwrite the
# non-zero path with a `failed:<reason>` outcome via the salvage helper.

# --- TODO(A4): salvage path -------------------------------------------------
#
# A4 wires:
#   - force-cleanup worktree + distill branch (already partially handled
#     by the trap, but A4 makes it explicit + idempotent on the failure
#     path so the failed-outcome write happens after the cleanup)
#   - write `failed:<reason>` outcome where <reason> is one of:
#       markers-after-agent-exit
#       head-not-on-default
#       agent-exit-nonzero
#       agent-timeout
#   - record recovery hint in the outcome sidecar (git revert HEAD,
#     reflog window for distill branches)
#
# At A2: on AGENT_RC != 0 we exit 1 without writing an outcome; the
# JS-side poller surfaces "abnormal termination — no outcome record"
# (warning), which is conservative until A4 lands.

if [ "$AGENT_RC" -ne 0 ]; then
  # Agent failed (crash, timeout 124, kill 137, or generic non-zero).
  # A4 will replace this with a real salvage + failed-outcome write;
  # at A2 we exit 1 so the JS-side abnormal-termination path fires.
  record_dangling_sha
  exit 1
fi

# Agent exit-0 path. At A2 this is unconditional `merged-content`.
# A3 differentiates merged-content vs merged-local vs failed:<reason>
# based on the validation helpers above.
write_outcome "merged-content"
exit 0
