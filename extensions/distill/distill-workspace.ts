/**
 * Per-distill workspace management.
 *
 * Each auto-distill invocation gets its own isolated git worktree so
 * concurrent distills (interval, shutdown, or multiple pi sessions) don't
 * race on vault files. Napkin resolves the vault from cwd, so a subprocess
 * launched with cwd = worktree operates on the worktree's copy of the vault.
 *
 * Layout per worktree:
 *   <worktree-root>/
 *     .napkin/
 *       distill/
 *         session.jsonl   # forked session, pi subprocess reads this
 *         meta.json       # DistillMeta, see below
 *
 * Lifecycle:
 *   createDistillWorkspace(vault, sessionFile)
 *     \u2192 createDistillWorktree(vault, branch, path)     (git worktree add -b ...)
 *     \u2192 SessionManager.forkFrom \u2192 session.jsonl
 *     \u2192 write meta.json
 *   ... distill subprocess runs in worktree ...
 *   removeDistillWorktree(vault, worktreePath, branch)
 *     \u2192 git worktree remove --force <path>
 *     \u2192 git branch -D <branch>
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { Napkin } from "@cad0p/napkin";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { buildDistillPrompt } from "./distill-prompt";
import { DISTILL_WRAPPER_SCRIPT, MERGE_DRIVER_SCRIPT } from "./scripts-paths";

/**
 * Error class thrown by distill-workspace operations. Separate class so
 * callers can distinguish workspace-layer failures (worktree / git / fs)
 * from generic Errors raised by the stdlib.
 */
export class DistillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DistillError";
  }
}

/**
 * Metadata written to each distill workspace's `meta.json`. Consumed by the
 * Phase C `/distill-status` command and the forensic error-log path: if a
 * distill crashes, the on-disk meta plus the dangling branch SHA let us
 * recover the work or at least explain it.
 *
 * Schema is append-only. Readers MUST tolerate unknown fields.
 */
export interface DistillMeta {
  /**
   * PID of the detached wrapper shell. Written first as a pre-spawn
   * placeholder (= `process.pid` of the parent pi session) by
   * `createDistillWorkspace`, then OVERWRITTEN by the wrapper itself
   * (`$$`) immediately after it installs its cleanup trap. Readers see the
   * wrapper's pid for the vast majority of the distill's lifetime; only a
   * brief window (≲ 100ms between JS write and wrapper's rewrite) shows the
   * parent pid. Liveness checks (`/distill-status.alive`,
   * `cleanupStaleWorktrees`) use this field via `process.kill(pid, 0)`.
   */
  pid: number;
  /** Absolute path to the main vault (NOT the worktree). */
  vault: string;
  /** Git branch name created for this distill, e.g. `distill/a1b2c3-1715198400`. */
  branch: string;
  /** ISO-8601 timestamp when the workspace was created. */
  startedAt: string;
  /** Absolute path to the parent session's .jsonl (for traceability). */
  parentSession: string;
  /**
   * HEAD commit SHA (in the main repo) at the moment the worktree was
   * created. Used by per-distill-completion overlap detection to enumerate
   * exactly the files the distill affected (post-squash, from the main
   * vault):
   *
   *   git -C <vaultPath> log --name-only <startSha>..HEAD
   *
   * Also useful for the live `diffWorktreeSinceStart` helper while the
   * worktree is still alive (status displays, debugging).
   *
   * Absent on meta.json files written by pre-Phase-C2 code paths — readers
   * MUST tolerate undefined and fall back to scanning the whole worktree.
   */
  startSha?: string;
}

/**
 * Handle returned by `createDistillWorkspace`. All paths are absolute and
 * live inside the worktree root.
 */
export interface DistillWorkspace {
  /** Worktree root (the `cwd` for the distill subprocess). */
  worktreePath: string;
  /** Branch name created for this distill (unique per invocation). */
  branchName: string;
  /** Path to the forked session .jsonl inside the worktree. */
  sessionForkPath: string;
  /** Path to meta.json inside the worktree. */
  metaPath: string;
  /**
   * Vault HEAD SHA at workspace-creation time — the distill's fork point.
   * Used by per-completion overlap detection (R7-PERF-2): once the distill
   * has squash-merged onto main, `git log --name-only <startSha>..HEAD`
   * from the main vault enumerates exactly the files the distill
   * affected. Undefined if HEAD couldn't be resolved at creation time
   * (e.g. fresh repo with no commits) — callers must tolerate that.
   */
  startSha?: string;
}

/**
 * Generate a unique branch name per distill invocation. Format:
 *   distill/<6-hex-nonce>-<epoch-seconds>
 *
 * Nonce prevents collisions when two distills fire in the same second (unlikely
 * but cheap to prevent; relying on timestamp alone is a latent race).
 */
export function generateDistillBranchName(
  now: Date = new Date(),
  nonceHex?: string,
): string {
  const nonce = nonceHex ?? randomBytes(3).toString("hex");
  const epoch = Math.floor(now.getTime() / 1000);
  return `distill/${nonce}-${epoch}`;
}

/**
 * Relative path (from worktree root) of the distill `.napkin/distill/` dir.
 */
export const DISTILL_SUBDIR = path.join(".napkin", "distill");

/**
 * Resolve the root directory where this vault's distill worktrees live.
 * Follows XDG Base Directory Spec: `~/.cache/napkin-distill/<hash>/` by
 * default, `$XDG_CACHE_HOME/napkin-distill/<hash>/` when set.
 *
 * `<hash>` is the first 16 hex chars of sha256(vaultContentPath) — stable
 * per vault, unique across vaults. Prevents worktrees from two different
 * vaults colliding under the same cache dir while keeping the path short
 * and inspectable.
 *
 * Worktree placement outside the vault is deliberate:
 *   - Cloud-sync pollution: OneDrive/Dropbox don't respect `.gitignore`;
 *     in-vault worktrees would upload tens of MB per distill spawn.
 *   - Filesystem-walker pollution: Obsidian plugins and `find` descend
 *     into worktrees and would see N full vault copies for N concurrent
 *     distills.
 *   - Autocommit-cron noise: a vault's autocommit hook can surface
 *     in-vault worktrees as gitlinks under some command sequences.
 *   - Git convention: git-worktree docs show worktrees as siblings of
 *     the main repo, never nested inside it.
 *   - Safety escape hatch: `rm -rf ~/.cache/napkin-distill/<hash>/` is
 *     always safe — anything valuable is already on main or was never
 *     going to commit.
 *
 * @param vaultContentPath Absolute path to the vault's content root
 *   (`napkin.vault.contentPath`, NOT configPath — they're distinct in
 *   subdir layout and we want one hash per vault, not per config dir).
 *
 * The path is canonicalised through `fs.realpathSync` before hashing so
 * equivalent paths that differ only in symlink presence (e.g.
 * `~/workplace` → `/workplace/pcad`) resolve to the same cache dir. A
 * stale symlink (ENOENT) falls back to the raw path so the caller sees
 * a deterministic hash rather than an unrelated throw.
 */
export function resolveCacheRoot(vaultContentPath: string): string {
  const cacheHome =
    process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  let canonical: string;
  try {
    canonical = fs.realpathSync(vaultContentPath);
  } catch {
    // Broken symlink, missing dir, or permission error — fall back to the
    // raw path. Produces a stable hash for the same input even if the
    // realpath machinery is unavailable; worst case is that two different
    // views of the same vault hash to different cache dirs, which is the
    // pre-R4-L-1 behaviour.
    canonical = vaultContentPath;
  }
  const vaultHash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 16);
  return path.join(cacheHome, "napkin-distill", vaultHash);
}

/**
 * Throws `DistillError` if `vaultPath` is not a git repository. Phase B
 * requires auto-distill to run in a git context; Phase C's auto-init wires
 * session_start so this throw should never fire in practice for
 * distill.enabled vaults.
 */
function assertVaultIsGitRepo(vaultPath: string): void {
  const gitDir = path.join(vaultPath, ".git");
  if (!fs.existsSync(gitDir)) {
    throw new DistillError(
      `vault not a git repo: ${vaultPath} (auto-distill requires git; Phase C wires auto-init)`,
    );
  }
}

/**
 * Invoke `git` inside a specific cwd. Returns `{status, stdout, stderr}`.
 * Does not throw on non-zero exit \u2014 callers decide how to react (retry,
 * translate to DistillError, ignore, \u2026). 30s timeout per call is a sanity
 * ceiling; normal git invocations complete in milliseconds.
 *
 * `env: process.env` is required for Bun: unlike Node, Bun's spawnSync
 * does NOT propagate mutations to `process.env` to the child unless
 * `env` is passed explicitly (it snapshots env at runtime startup).
 * Without this, tests that manipulate PATH (e.g. to shim `git`) would
 * silently exec the real git. Matches the same fix in `auto-setup.ts`.
 */
function runGit(
  cwd: string,
  args: string[],
): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    env: process.env,
  });
  return {
    status: r.status,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

/**
 * Ensure the worktree's local git config has the napkin-distill-merge
 * driver registered, and that `.gitattributes` routes `*.md` through it.
 *
 * Registration is per-worktree (`--local`, stays in the worktree's git config
 * dir, never propagates to the main repo or gets committed). The
 * `.gitattributes` line is per-file though \u2014 if the vault doesn't already
 * have one routing `*.md` through the driver, we append one. The appended
 * line gets committed along with the distill's content changes, which is
 * fine: committing the merge-driver rule to the vault is what lets the
 * driver actually fire during the merge back to main.
 *
 * Phase C's auto-init will pre-scaffold `.gitattributes` so this append
 * becomes a no-op; until then, we self-heal.
 */
function registerMergeDriver(worktreePath: string): void {
  // Register the driver in local git config. Local config lives in the
  // worktree's `.git` file (actually in the main repo's .git/config, since
  // worktrees share config by default \u2014 the config applies during all git
  // operations from this worktree's perspective).
  const nameRes = runGit(worktreePath, [
    "config",
    "--local",
    "merge.napkin-distill-merge.name",
    "napkin distill LLM merge driver",
  ]);
  if (nameRes.status !== 0) {
    throw new DistillError(
      `failed to configure merge driver name: ${nameRes.stderr.trim()}`,
    );
  }
  // Quote the driver path so spaces / shell metacharacters in the path
  // don't break git's sh -c invocation of the driver command, and so a
  // malicious path prefix (unlikely locally, possible in CI with a
  // runner-controlled workspace path) can't inject arguments.
  // Single-quote the path and escape any literal ' as '\''.
  const quotedDriverPath = `'${MERGE_DRIVER_SCRIPT.replace(/'/g, "'\\''")}'`;
  const driverRes = runGit(worktreePath, [
    "config",
    "--local",
    "merge.napkin-distill-merge.driver",
    `${quotedDriverPath} %O %A %B %P`,
  ]);
  if (driverRes.status !== 0) {
    throw new DistillError(
      `failed to configure merge driver command: ${driverRes.stderr.trim()}`,
    );
  }

  // Ensure `*.md merge=napkin-distill-merge` is in .gitattributes. This is
  // the bit git consults during `git merge` to pick the driver. If
  // .gitattributes is missing or the line isn't present, append it.
  const attrsPath = path.join(worktreePath, ".gitattributes");
  const attrLine = "*.md merge=napkin-distill-merge";
  let existing = "";
  if (fs.existsSync(attrsPath)) {
    existing = fs.readFileSync(attrsPath, "utf-8");
  }
  if (!existing.split("\n").some((line) => line.trim() === attrLine)) {
    const sep = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
    fs.writeFileSync(attrsPath, `${existing}${sep}${attrLine}\n`);
  }
}

/**
 * Create a git worktree at `worktreePath` checked out to a fresh branch
 * `branchName` rooted at the vault's HEAD. Registers the napkin-distill-merge
 * driver in the worktree's local git config so subsequent `git merge`
 * invocations can resolve conflicts via the LLM.
 *
 * Precondition: vault is a git repo with at least one commit (HEAD
 * resolvable). Phase C's auto-init ensures both.
 *
 * @throws DistillError if:
 *   - vault has no `.git/` directory
 *   - `git worktree add` exits non-zero (branch collision, dirty state, ...)
 *   - merge driver registration fails
 *
 * @returns absolute worktree path on success (same as input, for chaining).
 */
export function createDistillWorktree(
  vaultPath: string,
  branchName: string,
  worktreePath: string,
): string {
  assertVaultIsGitRepo(vaultPath);

  // Verify HEAD resolves to a valid commit. An empty repo (git init
  // without any commit) has .git/HEAD pointing at refs/heads/main but no
  // commits to resolve to. `git worktree add ... HEAD` fails with exit
  // 128: "fatal: invalid reference: HEAD". Surface this as a DistillError
  // the caller can catch and log gracefully rather than a cryptic git
  // exit.
  //
  // auto-setup seeds an empty commit so the happy path never hits this,
  // but the guard stays cheap and catches vaults where .git came from
  // outside auto-setup (user's own `git init`, brazil workspace
  // scaffolding, etc.) and never got a commit.
  const headCheck = runGit(vaultPath, ["rev-parse", "--verify", "HEAD"]);
  if (headCheck.status !== 0) {
    throw new DistillError(
      `vault git repo has no commits yet (HEAD unresolvable); ` +
        `auto-distill can't create a worktree. Make an initial commit in ` +
        `${vaultPath} before using auto-distill, or rerun setup.`,
    );
  }

  // Ensure the parent of worktreePath exists; `git worktree add` requires a
  // non-existent target directory but will happily create intermediate dirs
  // for us \u2014 except when the parent (e.g. the vault's XDG cache root
  // `~/.cache/napkin-distill/<hash>/`) only exists after first use.
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  const res = runGit(vaultPath, [
    "worktree",
    "add",
    "-b",
    branchName,
    worktreePath,
    "HEAD",
  ]);
  if (res.status !== 0) {
    throw new DistillError(
      `git worktree add failed (exit ${res.status}): ${res.stderr.trim() || res.stdout.trim()}`,
    );
  }

  try {
    registerMergeDriver(worktreePath);
  } catch (err) {
    // Roll back the worktree if driver registration fails \u2014 an unregistered
    // worktree would merge with plain conflict markers instead of going
    // through the LLM, defeating the point.
    try {
      runGit(vaultPath, ["worktree", "remove", "--force", worktreePath]);
      runGit(vaultPath, ["branch", "-D", branchName]);
    } catch {
      // ignore
    }
    throw err;
  }

  return worktreePath;
}

/**
 * Remove a distill worktree and delete its branch. Idempotent \u2014 logs and
 * swallows errors because cleanup runs in shutdown / trap contexts where
 * throwing would mask more interesting failures upstream.
 *
 * Order matters: remove the worktree first (which releases the branch), then
 * delete the branch. Calling `git branch -D` while a worktree still holds
 * the branch fails.
 */
export function removeDistillWorktree(
  vaultPath: string,
  worktreePath: string,
  branchName: string,
): void {
  // Guard: vault may have been deleted between spawn and cleanup. Don't
  // throw \u2014 treat as "nothing to clean up".
  if (!fs.existsSync(path.join(vaultPath, ".git"))) return;

  const rmRes = runGit(vaultPath, [
    "worktree",
    "remove",
    "--force",
    worktreePath,
  ]);
  // If worktree removal fails, try to prune stale entries and continue on to
  // branch deletion; leaving a dangling branch is worse than a stale worktree.
  if (rmRes.status !== 0) {
    runGit(vaultPath, ["worktree", "prune"]);
  }

  // -D (force) in case the branch has unmerged content (expected: the squash
  // merge to main doesn't mark it as merged).
  runGit(vaultPath, ["branch", "-D", branchName]);

  // Best-effort rmdir of the parent vault-hash dir. rmdir is non-recursive
  // and only succeeds when the parent is empty (i.e. this was the last
  // distill for this vault).
  try {
    fs.rmdirSync(path.dirname(worktreePath));
  } catch {
    // ENOTEMPTY (other concurrent distills exist for this vault) and
    // ENOENT (race) are expected and benign. Other I/O errors swallowed
    // per this function's idempotent shutdown-context contract.
  }
}

/**
 * Create a distill workspace = a fresh git worktree + session fork + meta.
 *
 * Workflow:
 *   1. Pick a unique branch name (`distill/<hex>-<epoch>`).
 *   2. Compute worktree path: `<cacheRoot>/<branch-suffix>/` where
 *      `cacheRoot = resolveCacheRoot(vault)` (XDG cache; outside vault).
 *   3. `git worktree add -b <branch> <path> HEAD`.
 *   4. Make `<wt>/.napkin/distill/`, fork the source session into it, write
 *      meta.json.
 *   5. Return handle.
 *
 * On failure at any step after the worktree exists, the worktree + branch are
 * torn down via `removeDistillWorktree` so we never leak on throw.
 *
 * @param vault              Absolute path to the vault's content root (NOT a
 *                           worktree, NOT configPath). Used as the input to
 *                           the vault-hash so multi-vault setups isolate
 *                           cleanly.
 * @param sourceSessionFile  Absolute path to the parent session .jsonl.
 * @param parentCwd          Absolute path of the parent pi session's cwd.
 *                           Pinned into the fork header so the distill
 *                           subprocess's system prompt `Current working
 *                           directory:` line matches the parent's,
 *                           preserving prompt-cache hits across the spawn.
 *                           Routing of vault writes to the worktree happens
 *                           via the wrapper's per-distill `napkin` shim,
 *                           NOT cwd-based vault resolution. See
 *                           POST-R6-CACHE in features/pi-napkin-distill/deferred.md.
 *
 * @throws DistillError if vault isn't a git repo, worktree creation fails,
 *         or session fork fails.
 */
export function createDistillWorkspace(
  vault: string,
  sourceSessionFile: string,
  parentCwd: string,
): DistillWorkspace {
  assertVaultIsGitRepo(vault);

  // parentCwd is load-bearing for prompt-cache parity (POST-R6-CACHE):
  // pi is spawned at parentCwd so the session-fork header and the
  // resulting system prompt's `Current working directory:` line stay
  // byte-identical to the parent's. A relative path or a stale path
  // that doesn't exist would silently degrade to the wrapper's
  // `cd $PARENT_CWD || exit 1` graceful failure (UI-silent, error log
  // only). Validate up-front so the caller gets a clear DistillError
  // instead. (R7-SC-12, R7-CC-7.)
  if (!path.isAbsolute(parentCwd)) {
    throw new DistillError(
      `parentCwd must be an absolute path, got: ${parentCwd}`,
    );
  }
  if (!fs.existsSync(parentCwd)) {
    throw new DistillError(`parentCwd does not exist: ${parentCwd}`);
  }

  const branchName = generateDistillBranchName();
  const branchSuffix = branchName.slice("distill/".length);
  // Worktree lives OUTSIDE the vault, under the user's XDG cache dir. See
  // `resolveCacheRoot` for the full rationale (cloud-sync pollution,
  // autocommit-cron noise, plugin re-indexing). `git worktree list`
  // still enumerates these correctly regardless of placement.
  const worktreePath = path.join(resolveCacheRoot(vault), branchSuffix);

  // Capture HEAD SHA BEFORE the worktree is created so meta.json records
  // the exact commit the distill started from. Used by per-completion
  // overlap detection (R7-PERF-2): after the wrapper squash-merges onto
  // main, `git log --name-only <startSha>..HEAD` from the main vault
  // enumerates exactly the files the distill affected.
  // Failure to resolve HEAD is not fatal — leave `startSha` undefined.
  let startSha: string | undefined;
  {
    const headRes = runGit(vault, ["rev-parse", "HEAD"]);
    if (headRes.status === 0) {
      const sha = headRes.stdout.trim();
      if (/^[0-9a-f]{7,64}$/.test(sha)) startSha = sha;
    }
  }

  createDistillWorktree(vault, branchName, worktreePath);

  try {
    const distillDir = path.join(worktreePath, DISTILL_SUBDIR);
    fs.mkdirSync(distillDir, { recursive: true });

    // SessionManager.forkFrom writes to <sessionDir>/<uuid>.jsonl. We want a
    // deterministic name (`session.jsonl`) so the wrapper script can reference
    // it without globbing.
    //
    // Target cwd is the PARENT's cwd, not the worktree path — see the
    // `parentCwd` parameter docstring above for the full rationale.
    const forkedSm = SessionManager.forkFrom(
      sourceSessionFile,
      parentCwd,
      distillDir,
    );
    const forkedFile = forkedSm.getSessionFile();
    if (!forkedFile) {
      throw new DistillError(
        "SessionManager.forkFrom did not produce a session file",
      );
    }

    const sessionForkPath = path.join(distillDir, "session.jsonl");
    if (forkedFile !== sessionForkPath) {
      if (fs.existsSync(sessionForkPath)) {
        fs.rmSync(sessionForkPath, { force: true });
      }
      fs.renameSync(forkedFile, sessionForkPath);
    }

    const metaPath = path.join(distillDir, "meta.json");
    const meta: DistillMeta = {
      pid: process.pid,
      vault,
      branch: branchName,
      startedAt: new Date().toISOString(),
      parentSession: sourceSessionFile,
      startSha,
    };
    fs.writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`);

    return { worktreePath, branchName, sessionForkPath, metaPath, startSha };
  } catch (err) {
    // Roll back worktree + branch so we never leak on failure. The cleanup is
    // itself best-effort; if it fails, the original error is what the caller
    // cares about.
    try {
      removeDistillWorktree(vault, worktreePath, branchName);
    } catch {
      // ignore
    }
    throw err;
  }
}

/**
 * Remove a distill workspace. Idempotent: safe to call on partial state and
 * on a path that doesn't exist. Used by the `sh -c` wrapper's trap.
 *
 * Handles both the worktree + branch AND any leftover files inside the
 * worktree path (e.g., if the worktree was partially torn down by git but the
 * directory lingers).
 */
export function cleanupDistillWorkspace(
  vault: string,
  workspace: Pick<DistillWorkspace, "worktreePath" | "branchName">,
): void {
  removeDistillWorktree(vault, workspace.worktreePath, workspace.branchName);
  // Best-effort remove any leftover directory (git worktree remove normally
  // deletes it, but if the worktree was corrupted it may still exist).
  if (fs.existsSync(workspace.worktreePath)) {
    fs.rmSync(workspace.worktreePath, { recursive: true, force: true });
  }
}

/**
 * Parse `git worktree list --porcelain` output into a list of
 * `{ path, branch }` pairs. Only returns entries that have a branch (skips
 * detached-HEAD worktrees — we never create those for distills).
 *
 * Porcelain format is newline-separated records, each record is a block of
 * `key value` lines terminated by a blank line. We care about `worktree`
 * (absolute path) and `branch` (full ref, e.g. `refs/heads/distill/abc-1`).
 */
export function parseWorktreeList(
  porcelain: string,
): Array<{ path: string; branch: string }> {
  const out: Array<{ path: string; branch: string }> = [];
  let wt: string | null = null;
  let branch: string | null = null;
  const flush = () => {
    if (wt && branch) out.push({ path: wt, branch });
    wt = null;
    branch = null;
  };
  for (const line of porcelain.split("\n")) {
    if (line === "") {
      flush();
      continue;
    }
    if (line.startsWith("worktree ")) wt = line.slice("worktree ".length);
    else if (line.startsWith("branch "))
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
  }
  flush();
  return out;
}

/**
 * Liveness check: returns true if `pid` refers to a running process this
 * user can see. Uses signal 0 (no-op) — throws ESRCH when the pid is dead,
 * EPERM when it exists but is owned by another user (still "alive" from our
 * perspective — don't clean up someone else's worktree).
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // EPERM = exists but not signalable. Treat as alive (don't clobber).
    return e.code === "EPERM";
  }
}

/**
 * Number of minutes past which a worktree with a stale mtime on its
 * meta.json is considered abandoned — even if its pid is still alive.
 *
 * Covers the `distill.maxDurationMinutes` config (10 minutes by
 * default; read in the extension factory via `getMaxDistillDurationMs`)
 * with a 6× margin, so a worktree older than this either crashed
 * silently, lost its pid (e.g. kernel reboot), or somehow outlived its
 * shutdown timeout. The window is deliberately generous: a false-positive
 * here would clobber a slow-but-live distill, whereas waiting an extra
 * 50 minutes to sweep a dead one is harmless.
 */
export const STALE_WORKTREE_MINUTES = 60;

/**
 * Same threshold expressed in milliseconds for the mtime comparison site.
 * Kept as a separate export because existing callers (and tests) already
 * import `STALE_META_AGE_MS` directly.
 */
export const STALE_META_AGE_MS = STALE_WORKTREE_MINUTES * 60 * 1000;

/**
 * VaultInfo-shaped handle this module accepts. We rely only on `contentPath`
 * (the vault root = the git main worktree root) — kept minimal so tests and
 * callers don't have to construct a full Napkin instance.
 */
export interface StaleCleanupVault {
  contentPath: string;
}

/**
 * Remove distill worktrees that belong to dead sessions. Intended to run
 * once per `session_start` so long-lived vaults don't accumulate debris
 * from crashed pi instances.
 *
 * A worktree (branch matches `^distill/.*`) is removed if ANY of:
 *   1. `<wt>/.napkin/distill/meta.json` is missing
 *   2. meta.json's `pid` is not a running process
 *   3. meta.json's mtime is older than STALE_META_AGE_MS
 *
 * Removal is best-effort: failures on one worktree don't abort the sweep.
 *
 * @returns number of worktrees removed.
 */
export function cleanupStaleWorktrees(vault: StaleCleanupVault): number {
  const vaultPath = vault.contentPath;
  // No git in the vault → nothing to clean up. session_start may call us
  // before auto-init runs on first launch.
  if (!fs.existsSync(path.join(vaultPath, ".git"))) return 0;

  const listRes = runGit(vaultPath, ["worktree", "list", "--porcelain"]);
  if (listRes.status !== 0) return 0;

  const entries = parseWorktreeList(listRes.stdout).filter((e) =>
    e.branch.startsWith("distill/"),
  );

  let removed = 0;
  for (const entry of entries) {
    try {
      const metaPath = path.join(entry.path, DISTILL_SUBDIR, "meta.json");
      let shouldRemove = false;

      if (!fs.existsSync(metaPath)) {
        shouldRemove = true;
      } else {
        let mtime = 0;
        try {
          mtime = fs.statSync(metaPath).mtimeMs;
        } catch {
          shouldRemove = true;
        }
        if (!shouldRemove) {
          const meta = readDistillMeta(entry.path);
          if (!meta) {
            shouldRemove = true;
          } else if (!isPidAlive(meta.pid)) {
            shouldRemove = true;
          } else if (Date.now() - mtime > STALE_META_AGE_MS) {
            shouldRemove = true;
          }
        }
      }

      if (shouldRemove) {
        removeDistillWorktree(vaultPath, entry.path, entry.branch);
        removed += 1;
      }
    } catch {
      // Per-worktree failure is non-fatal; keep sweeping.
    }
  }

  return removed;
}

/**
 * Read a workspace's meta.json. Returns null if the file doesn't exist or
 * can't be parsed \u2014 callers treat this as "workspace is gone or stale".
 *
 * Never throws on missing files; throws only on unexpected I/O errors
 * (permissions, disk failure) that indicate a deeper problem.
 */
export function readDistillMeta(worktreePath: string): DistillMeta | null {
  const metaPath = path.join(worktreePath, DISTILL_SUBDIR, "meta.json");
  if (!fs.existsSync(metaPath)) return null;
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as DistillMeta;
    // Light schema check: these fields are required by all consumers.
    if (
      typeof parsed.pid !== "number" ||
      typeof parsed.vault !== "string" ||
      typeof parsed.branch !== "string" ||
      typeof parsed.startedAt !== "string" ||
      typeof parsed.parentSession !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Result of `spawnDistillInWorktree` — returned for bookkeeping and tests.
 * The caller typically stores nothing beyond `workspace.branchName` so
 * `/distill-status` can later discover active workspaces by enumerating
 * `git worktree list` and reading their `meta.json`.
 */
export interface SpawnDistillResult {
  workspace: DistillWorkspace;
  /** PID of the detached wrapper. The parent process MUST NOT wait on it. */
  pid: number;
}

/**
 * Resolve the absolute path to the distill error log directory for a
 * given vault. Mirrors the logic the wrapper uses internally so the
 * JS-side completion check can find error logs the wrapper produced.
 *
 * Falls back to `<vault>/.napkin/distill/errors/` if napkin's vault
 * resolution throws (defensive — the upstream caller has typically
 * already resolved the vault successfully). The returned path may not
 * exist on disk; callers should check before reading.
 */
export function resolveDistillErrorDir(vault: string): string {
  try {
    return path.join(new Napkin(vault).vault.configPath, "distill", "errors");
  } catch {
    return path.join(vault, ".napkin", "distill", "errors");
  }
}

/**
 * Find the wrapper-emitted error log for a specific distill branch, if
 * any. The wrapper writes ‘forensic’ logs to
 * `<errorDir>/<ISO-timestamp>-<pid>-<branch-short>.log` whenever it
 * fails (missing napkin, pi subprocess error, merge driver 3-strike,
 * cd parent_cwd failure, …). Returns the absolute path to the first
 * matching log file, or null when no log exists.
 *
 * `branchShort` is the part after `distill/`, e.g. for
 * `distill/abc1234-1715198400` pass `abc1234-1715198400`.
 *
 * Used by `runDistillWith`'s success path to detect wrapper failures
 * that don't surface as a timeout (e.g. wrapper exited 1 quickly).
 * Mirrors the timeout-surfacing pattern: target gone + error log
 * present → paint failure in UI; target gone + no error log → success.
 */
export function findDistillErrorLogForBranch(
  errorDir: string,
  branchShort: string,
): string | null {
  if (!fs.existsSync(errorDir)) return null;
  if (branchShort.length === 0) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(errorDir);
  } catch {
    return null;
  }
  const suffix = `-${branchShort}.log`;
  // Pick the most recent matching file (lexicographic order is
  // chronologically meaningful because the prefix is an ISO
  // timestamp). Multiple logs for the same branch shouldn't happen in
  // practice, but if they do, returning the latest is the right call.
  const matches = entries.filter((f) => f.endsWith(suffix)).sort();
  if (matches.length === 0) return null;
  return path.join(errorDir, matches[matches.length - 1]);
}

/**
 * Find the most recent outcome sidecar for a distill branch. Returns
 * `{ class, outcomePath, partialMergeLogPath }` when a `*.outcome` file
 * exists for `branchShort`, else null.
 *
 * The outcome sidecar (POST-CONV-5) is written by the wrapper as the
 * LAST action before any successful exit-0 path. One-line content is
 * the class string: `merged-content` / `no-content` / `partial-merge`.
 * Used by the JS-side `runDistillWith` poller to dispatch the right UI
 * severity (info vs warn) since multiple `exit 0` wrapper paths
 * previously produced the same notification.
 *
 * Missing outcome AND missing fatal error log = abnormal termination
 * (SIGKILL / `set -e` / disk full / race) — caller must surface this
 * as a warn since the wrapper is detached and we have no other signal
 * channel.
 *
 * `partialMergeLogPath` is populated when the class is `partial-merge`
 * AND a matching `.partial-merge.log` (R8-CC-1) exists in the same
 * directory; null otherwise. Caller can read the log to count
 * reverted files for the user-facing message.
 */
export function findDistillOutcomeForBranch(
  errorDir: string,
  branchShort: string,
): {
  outcomeClass: string;
  outcomePath: string;
  partialMergeLogPath: string | null;
  /**
   * Optional recovery hint emitted by the wrapper's salvage path
   * (PR #12 A4). Lines 2+ of the outcome sidecar; absent on happy-
   * path classes (`merged-content`, `merged-local`, `no-content`)
   * since they need no recovery action.
   */
  recoveryHint: string | null;
} | null {
  if (!fs.existsSync(errorDir)) return null;
  if (branchShort.length === 0) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(errorDir);
  } catch {
    return null;
  }
  const outcomeSuffix = `-${branchShort}.outcome`;
  const outcomes = entries.filter((f) => f.endsWith(outcomeSuffix)).sort();
  if (outcomes.length === 0) return null;
  const outcomePath = path.join(errorDir, outcomes[outcomes.length - 1]);
  // PR #12 A4: outcome sidecar format is multi-line
  //   line 1   = outcome class (machine-readable, drives JS-side dispatch)
  //   lines 2+ = optional human-readable recovery hint (failed:* only)
  // Pre-PR-12 sidecars are single-line; the split below handles both
  // shapes: `lines[0]` is always the class, `lines.slice(1).join('\n')`
  // is empty for legacy single-line sidecars.
  let outcomeClass = "";
  let recoveryHint: string | null = null;
  try {
    const raw = fs.readFileSync(outcomePath, "utf-8");
    const lines = raw.split("\n");
    outcomeClass = (lines[0] ?? "").trim();
    const restRaw = lines.slice(1).join("\n").trim();
    recoveryHint = restRaw.length > 0 ? restRaw : null;
  } catch {
    // Treat unreadable outcome as missing — caller will fall through to
    // abnormal-termination handling.
    return null;
  }
  let partialMergeLogPath: string | null = null;
  if (outcomeClass === "partial-merge") {
    const pmSuffix = `-${branchShort}.partial-merge.log`;
    const pmMatches = entries.filter((f) => f.endsWith(pmSuffix)).sort();
    if (pmMatches.length > 0) {
      partialMergeLogPath = path.join(
        errorDir,
        pmMatches[pmMatches.length - 1],
      );
    }
  }
  return { outcomeClass, outcomePath, partialMergeLogPath, recoveryHint };
}

/**
 * Prefix prepended to the distill prompt only when running through the
 * worktree spawn path. Tells the agent its writes must stay inside the
 * per-distill worktree — critical because the agent inherits the parent
 * session's full message history (which contains absolute paths to the
 * MAIN vault) and would otherwise route writes there via `edit`/`write`
 * with absolute paths, silently bypassing worktree isolation.
 *
 * The prefix is added inside `spawnDistillInWorktree` (not at call sites)
 * so every worktree-mode caller gets it automatically. Legacy spawn
 * (manual /distill on git-less or disabled vaults) does NOT prepend
 * this — there's no isolation to preserve there.
 *
 * Exported for tests; production callers should rely on the implicit
 * application inside `spawnDistillInWorktree`.
 *
 * See POST-R6-CACHE in features/pi-napkin-distill/deferred.md for context.
 */
export function buildWorktreeDistillPrompt(
  worktreePath: string,
  basePrompt: string,
): string {
  return `You are running in an isolated git worktree at ${worktreePath}. Only modify files within the worktree. Do NOT use absolute paths from the conversation history — those refer to the main vault and bypass isolation, causing the distill to silently merge nothing.\n\n${basePrompt}`;
}

/**
 * Arguments to `spawnDistillInWorktree`. Separated as an interface so callers
 * don't have to remember positional arg order — and so tests can supply the
 * `spawn` override without pulling in the full function signature.
 */
export interface SpawnDistillOptions {
  /** Absolute path to the main vault (NOT a worktree). */
  vault: string;
  /** Absolute path to the current session .jsonl to fork from. */
  sessionFile: string;
  /**
   * Parent pi session's cwd. Pinned into the fork header and used as the
   * spawn cwd so the distill subprocess's system prompt cwd line matches
   * the parent's, preserving prompt-cache hits. Vault-write routing to the
   * worktree is handled by the wrapper's napkin shim, NOT cwd resolution.
   */
  parentCwd: string;
  /** Optional model override, `<provider>/<id>`. Undefined → pi's default. */
  model?: string;
  /**
   * Hard wall-clock budget (seconds) for the agent's distill+merge+squash+
   * push+cleanup task. Wired into the wrapper's `timeout(1)` invocation so
   * the agent is SIGTERMed (then SIGKILLed after grace) on overrun. Derived
   * from `distill.maxDurationMinutes` (default 10 min = 600s). Must be a
   * positive integer.
   *
   * PR #12 collapses the old per-phase timeouts (distill / per-file merge /
   * squash) into this single agent-task budget — there are no per-phase
   * subprocesses anymore for the wrapper to time-bound separately.
   */
  maxDurationSecs: number;
  /**
   * Override for the `spawn` function — wired by unit tests to capture calls
   * without actually starting processes. Defaults to the node:child_process
   * export at module load time.
   */
  spawnFn?: typeof spawn;
}

/**
 * Detect the vault's default mainline branch. Strategy (first hit wins):
 *   1. `git symbolic-ref refs/remotes/origin/HEAD` — when the vault has a
 *      remote `origin`, its HEAD points at the conventional default.
 *   2. Current branch via `git symbolic-ref --short HEAD` — for local-only
 *      vaults (fresh `git init` on a user's machine, no remote), the
 *      currently checked-out branch IS the default.
 *   3. Fall back to `main` — matches our `git init -b main` in auto-setup.
 *
 * Never throws. Returns a plain short branch name (e.g. `main`, `master`,
 * `trunk`) with no `refs/heads/` prefix.
 *
 * The return value is passed to the wrapper so the `git merge <default>`
 * step inside the worktree targets the vault's actual mainline —
 * hardcoding `main` silently corrupts vaults that use `master` or any
 * other default-branch convention.
 */
export function detectDefaultBranch(vaultPath: string): string {
  // origin/HEAD gives `refs/remotes/origin/<branch>` when set.
  const originRes = runGit(vaultPath, [
    "symbolic-ref",
    "refs/remotes/origin/HEAD",
  ]);
  if (originRes.status === 0) {
    const ref = originRes.stdout.trim();
    const match = ref.match(/^refs\/remotes\/origin\/(.+)$/);
    if (match && match[1].length > 0) return match[1];
  }
  // HEAD gives `<branch>` directly when --short is used.
  const headRes = runGit(vaultPath, ["symbolic-ref", "--short", "HEAD"]);
  if (headRes.status === 0) {
    const branch = headRes.stdout.trim();
    if (branch.length > 0) return branch;
  }
  return "main";
}

/**
 * Spawn a detached wrapper that performs the full auto-distill lifecycle
 * (pi → commit → merge → squash → cleanup) inside a per-distill worktree.
 *
 * Parent returns synchronously after the child is `unref`'d; the wrapper
 * survives parent exit (this is critical for shutdown distill — the parent
 * pi session is exiting, and the wrapper keeps running). All error paths
 * write to `<vault>/.napkin/distill/errors/` and do NOT block the parent.
 *
 * @throws DistillError if the workspace can't be created (git not a repo,
 *         branch collision, fork failure, …). Errors at this layer are
 *         unrecoverable by the caller beyond logging — no child to clean up
 *         (workspace creation rolled back on throw).
 */
export function spawnDistillInWorktree(
  opts: SpawnDistillOptions,
): SpawnDistillResult {
  const { vault, sessionFile, parentCwd, model, maxDurationSecs } = opts;
  const spawnFn = opts.spawnFn ?? spawn;

  const workspace = createDistillWorkspace(vault, sessionFile, parentCwd);

  const defaultBranch = detectDefaultBranch(vault);

  // Build the agent-driven distill prompt by substituting the four
  // placeholders into `extensions/distill/distill-prompt.md`. The .md
  // contains the full agent contract (steps 1–6 distill content + steps
  // 7–10 merge/squash/push/cleanup) plus the worktree-isolation prefix
  // from POST-R6-CACHE — see PR #12 design "Agent contract". The wrapper
  // hands this directly to `pi -p` as the agent's task; PR #12 deletes the
  // per-file merge driver entirely.
  const finalPrompt = buildDistillPrompt({
    worktreePath: workspace.worktreePath,
    vaultPath: vault,
    branchName: workspace.branchName,
    defaultBranch,
  });

  // Error dir lives on the MAIN vault (not in the worktree — worktrees are
  // removed on cleanup, which would lose the logs). Resolve via Napkin's
  // configPath so legacy (~/.napkin) and new (<content>/.napkin) layouts
  // both work.
  const errorDir = resolveDistillErrorDir(vault);
  fs.mkdirSync(errorDir, { recursive: true });

  const wrapperArgs = [
    DISTILL_WRAPPER_SCRIPT,
    vault,
    workspace.worktreePath,
    workspace.branchName,
    workspace.sessionForkPath,
    finalPrompt,
    errorDir,
    model ?? "",
    defaultBranch,
    parentCwd,
    String(maxDurationSecs),
    // SEC-2 / CORR-3: pass the resolved cache root as an explicit
    // positional arg so the wrapper's safe_rm_worktree path-safety
    // guard can require worktrees to be descendants of THIS cache
    // root (not just any path containing `/napkin-distill/<x>/<y>/`).
    // The JS side is the source of truth — `resolveCacheRoot()` here
    // is the same function that built `workspace.worktreePath`, so
    // a future refactor that changes the cache layout updates both
    // sides at once. Without this arg, the wrapper had to fall back
    // on a glob pattern that any path containing the napkin-distill
    // segment would satisfy.
    resolveCacheRoot(vault),
  ];

  // Detached spawn: stdio "ignore" + unref() so the parent can exit cleanly
  // while the wrapper continues. cwd is the PARENT's cwd — not the worktree
  // — so pi's process.cwd() at startup matches the session-fork header's
  // cwd, keeping the system prompt's `Current working directory:` line
  // byte-identical to the parent's. The wrapper handles git ops in the
  // worktree and installs a napkin shim that auto-routes vault writes to
  // the worktree.
  //
  // Invoke via `bash` (not `sh`): the wrapper's shebang is `#!/usr/bin/env
  // bash` and it relies on bash-specific syntax (arrays `pi_args=(...)`,
  // `set -o pipefail`). On Ubuntu/Debian, `/bin/sh` is `dash` which
  // parse-errors on bash syntax and exits 2 before the wrapper runs.
  const proc = spawnFn("bash", wrapperArgs, {
    cwd: parentCwd,
    detached: true,
    stdio: "ignore",
    env: {
      ...process.env,
      NAPKIN_DISTILL_NO_RECURSE: "1",
    },
  });
  proc.unref();

  return {
    workspace,
    pid: proc.pid ?? -1,
  };
}

// ============================================================================
// Status helpers (/distill-status + napkin_distill_status tool, Phase C2)
// ============================================================================

/**
 * Shape returned by `getActiveDistills`. Each entry represents a worktree
 * currently linked to the vault's git repo on a `distill/*` branch
 * (placement is under the XDG cache dir, not inside the vault).
 * Liveness (`alive`) is decided at read time via `process.kill(pid, 0)`,
 * so a freshly crashed wrapper is reported with `alive: false` (and
 * `/distill-status` renders it as stale).
 *
 * Fields are kept flat + JSON-friendly so the pi tool can serialize the
 * array directly.
 */
export interface ActiveDistill {
  pid: number;
  branch: string;
  worktreePath: string;
  /** ISO-8601 timestamp from meta.json. Null if meta.json is unparseable. */
  startedAt: string | null;
  /** Milliseconds since `startedAt`. 0 when `startedAt` is null. */
  elapsedMs: number;
  /** Absolute path to the parent session's .jsonl. Null if unavailable. */
  sessionPath: string | null;
  /** `process.kill(pid, 0)` result — true if the pid is signalable. */
  alive: boolean;
  /**
   * HEAD SHA from meta.json when the worktree was created. Undefined for
   * pre-Phase-C2 meta files. Used by the overlap injector to diff only
   * files this distill has written.
   */
  startSha?: string;
}

/**
 * Enumerate active distill worktrees for a vault.
 *
 * An "active distill" is a git worktree whose branch is named `distill/*`.
 * We do NOT filter by pid liveness here — dead entries are still reported
 * so the UI can distinguish "in flight" from "crashed, needs cleanup". The
 * caller decides how to render them.
 *
 * Returns an empty array on any error (missing .git, `git worktree list`
 * failure, etc.). Never throws: this is called from UI paths that must not
 * block on git hiccups.
 *
 * Invokes `git worktree list --porcelain` exactly once and does NOT touch
 * the branch list — so callers that only need the active set (e.g. the
 * `/distill-status` slash command and `napkin_distill_status` agent tool)
 * don't pay for a `git branch` invocation they don't need.
 * (R2-4: restored a pre-CLN-3 fast path.)
 */
export function getActiveDistills(vault: StaleCleanupVault): ActiveDistill[] {
  return toActiveDistills(listDistillWorktrees(vault.contentPath));
}

/**
 * Enumerate `distill/*` branches that exist in the vault repo but are NOT
 * currently checked out in any worktree. These are usually leftover from a
 * crashed distill whose worktree was removed but whose branch (or, more
 * often, its squash-merge-candidate commits) lingers pending GC.
 *
 * The output is intended for human triage via `/distill-status` — the user
 * can inspect and `git branch -D` them manually. We do NOT auto-prune
 * here: that's `cleanupStaleWorktrees`' job, and a lingering branch is
 * forensic breadcrumb, not debt.
 *
 * Returns empty on no-git / git-error. Never throws.
 *
 * Calls `git worktree list` + `git branch --list` (both are needed: a
 * branch can exist without a worktree). Skips the per-entry
 * meta.json/liveness hydration that `getActiveDistills` does.
 */
export function getUnmergedDistillBranches(vault: StaleCleanupVault): string[] {
  const vaultPath = vault.contentPath;
  const worktrees = listDistillWorktrees(vaultPath);
  const branches = listDistillBranches(vaultPath);
  const inWorktrees = new Set(worktrees.map((e) => e.branch));
  return branches.filter((b) => !inWorktrees.has(b));
}

/**
 * Combined snapshot of distill state for a vault, returned in a single
 * pass over git plumbing. Used by `/distill-status` — the user wants
 * "what's running" *and* "what's pending cleanup" at the same time.
 *
 * Behavior is equivalent to calling `getActiveDistills` + `getUnmergedDistillBranches`
 * back-to-back, but we invoke `git worktree list --porcelain` exactly once
 * instead of twice. `git branch --list 'distill/*'` is still needed to
 * enumerate orphan branches (a branch can exist without a worktree).
 *
 * Returns `{ active: [], unmerged: [] }` on any error — never throws.
 */
export function getDistillState(vault: StaleCleanupVault): {
  active: ActiveDistill[];
  unmerged: string[];
} {
  const vaultPath = vault.contentPath;
  const worktrees = listDistillWorktrees(vaultPath);
  const active = toActiveDistills(worktrees);
  const branches = listDistillBranches(vaultPath);
  const inWorktrees = new Set(worktrees.map((e) => e.branch));
  const unmerged = branches.filter((b) => !inWorktrees.has(b));
  return { active, unmerged };
}

/**
 * Primitive: enumerate `distill/*` worktree entries for a vault.
 *
 * Returns the subset of `git worktree list --porcelain` entries whose
 * branch is under `distill/*`. Empty on no-git / git-error. Cheap: one
 * `spawnSync` call plus a string split.
 *
 * Used by:
 *   - {@link getActiveDistills} directly (no branch listing needed).
 *   - {@link getUnmergedDistillBranches} (combined with branch list).
 *   - {@link getDistillState} (combined).
 */
function listDistillWorktrees(
  vaultPath: string,
): { path: string; branch: string }[] {
  if (!fs.existsSync(path.join(vaultPath, ".git"))) return [];
  const listRes = runGit(vaultPath, ["worktree", "list", "--porcelain"]);
  if (listRes.status !== 0) return [];
  return parseWorktreeList(listRes.stdout).filter((e) =>
    e.branch.startsWith("distill/"),
  );
}

/**
 * Primitive: enumerate `distill/*` branches (irrespective of worktrees).
 *
 * Empty on no-git / git-error. One `git branch --list` invocation.
 */
function listDistillBranches(vaultPath: string): string[] {
  if (!fs.existsSync(path.join(vaultPath, ".git"))) return [];
  const branchesRes = runGit(vaultPath, [
    "branch",
    "--list",
    "distill/*",
    "--format=%(refname:short)",
  ]);
  if (branchesRes.status !== 0) return [];
  return branchesRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Primitive: hydrate worktree entries into `ActiveDistill[]` with
 * meta.json + pid-liveness.
 *
 * Per entry: one `readDistillMeta` (bounded FS read) + one
 * `isPidAlive` call (`process.kill(pid, 0)`). No git invocation.
 */
function toActiveDistills(
  entries: { path: string; branch: string }[],
): ActiveDistill[] {
  const active: ActiveDistill[] = [];
  for (const entry of entries) {
    const meta = readDistillMeta(entry.path);
    const pid = meta?.pid ?? -1;
    const startedAt = meta?.startedAt ?? null;
    const elapsedMs =
      startedAt !== null ? Date.now() - new Date(startedAt).getTime() : 0;
    const sessionPath = meta?.parentSession ?? null;
    const alive = pid > 0 ? isPidAlive(pid) : false;
    active.push({
      pid,
      branch: entry.branch,
      worktreePath: entry.path,
      startedAt,
      elapsedMs: Math.max(0, elapsedMs),
      sessionPath,
      alive,
      startSha: meta?.startSha,
    });
  }
  return active;
}

/**
 * Return the list of files an active distill worktree has changed since
 * it forked from the vault's HEAD. Used by live diagnostic surfaces
 * (status, debugging) while the worktree exists.
 *
 * For the per-distill-completion overlap notice (R7-PERF-2) the worktree
 * is already gone by the time we look — use
 * `getDistillTouchedFilesPostSquash(vault, startSha)` instead, which
 * runs against the main vault's commit log.
 *
 * Strategy:
 *   - When `startSha` is recorded in meta.json (Phase C2+), diff
 *     `<startSha>..HEAD` inside the worktree. That gives exactly the set
 *     of files the distill has committed.
 *   - When `startSha` is absent (legacy meta.json), fall back to
 *     `git status --porcelain` inside the worktree — captures both
 *     committed-and-not-merged AND uncommitted changes. Less precise but
 *     still useful for overlap detection.
 *
 * All paths are returned relative to the worktree root (which is the same
 * as the vault root from a tracking perspective). Returns `[]` on any
 * error — overlap detection is best-effort and must not throw.
 */
export function diffWorktreeSinceStart(
  active: Pick<ActiveDistill, "worktreePath" | "startSha">,
): string[] {
  if (!fs.existsSync(active.worktreePath)) return [];
  if (active.startSha) {
    const r = runGit(active.worktreePath, [
      "diff",
      "--name-only",
      `${active.startSha}..HEAD`,
    ]);
    if (r.status !== 0) return [];
    return r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  }
  // Legacy fallback: uncommitted + committed changes (porcelain lists both).
  // Format: `XY path` where XY is the 2-char status code.
  const r = runGit(active.worktreePath, ["status", "--porcelain"]);
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((l) => l.slice(3).trim())
    .filter((l) => l.length > 0);
}

/**
 * Return the list of files affected by commits in the main vault between
 * `startSha` (the distill's fork point) and HEAD (post-squash, after the
 * wrapper's squash-merge has landed). Used by per-completion overlap
 * detection (R7-PERF-2) to compare against the parent session's writes.
 *
 * Unlike `diffWorktreeSinceStart`, this runs against the MAIN vault —
 * the distill worktree has been removed by the time we're called. The
 * squash commit on main brings every file the distill affected into
 * `<startSha>..HEAD`'s name range.
 *
 * If `startSha` is missing (legacy distill meta) we cannot reliably
 * compute the post-squash file set without scanning the now-removed
 * worktree, so we return `[]`. Overlap detection is best-effort.
 *
 * Paths are returned relative to the vault root (matching
 * `getSessionTouchedFiles` output for the intersection step).
 *
 * Downstream `intersectFiles` matches paths in three layers — exact /
 * symmetric-suffix / basename-fallback. The basename-fallback's known
 * false-positive shape (two unrelated `README.md`s in different
 * subtrees match) flows through here too; accepted because the overlap
 * notice is non-destructive (advisory message, doesn't modify files).
 * Concurrent-distill log noise is a separate accepted false-positive
 * class (when two pi sessions on the same vault complete in close
 * succession, the second's `<startSha>..HEAD` includes the first's
 * squash commit). See `deferred.md` R8-CC-5.
 */
export function getDistillTouchedFilesPostSquash(
  vaultPath: string,
  startSha: string | undefined,
): string[] {
  if (!startSha) return [];
  const r = runGit(vaultPath, [
    "log",
    `${startSha}..HEAD`,
    "--name-only",
    "--format=",
  ]);
  if (r.status !== 0) return [];
  const files = new Set<string>();
  for (const line of r.stdout.split("\n")) {
    const f = line.trim();
    if (f.length > 0) files.add(f);
  }
  return Array.from(files);
}
